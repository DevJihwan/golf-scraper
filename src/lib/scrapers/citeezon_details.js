// src/lib/scrapers/citeezen_detail.js
import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { readProgress, saveProgress } from '../../utils/progressManager.js';
// import { convertJsonToExcel } from '../../utils/excelConverter.js'; // 필요 시 활성화

const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)

// 중복 제거 함수 (매장명 기준)
function removeDuplicates(stores) {
    const uniqueStores = [];
    const storeNames = new Set();
    for (const store of stores) {
        if (!storeNames.has(store.상호명)) {
            storeNames.add(store.상호명);
            uniqueStores.push(store);
        }
    }
    return uniqueStores;
}

export async function scrapeCiteezenDetails(stopSignal = () => false, logInfo, logWarn, logError) {
    const scraperName = 'citeezon_details'; // 정확히 'citeezon_details'로 설정
    logInfo(`=== ${scraperName} 스크래핑 시작 ===`);

    // 진행 상태 읽기
    let progress = await readProgress(scraperName);
    let { currentIndex } = progress;
    if (currentIndex === undefined) currentIndex = 0; // 초기값 설정

    logInfo(`Loaded progress - currentIndex: ${currentIndex}`);

    // Puppeteer가 자동으로 다운로드한 Chromium 경로 사용
    const executablePath = puppeteer.executablePath();

    if (!fs.existsSync(executablePath)) {
        logError('Chromium executable not found at:', executablePath);
        throw new Error('Chromium executable not found');
    }

    // 임시 디렉토리 사용
    const userDataDir = path.join(os.tmpdir(), 'puppeteer-user-data');

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        userDataDir: userDataDir
    });

    const page = await browser.newPage();

    // 네비게이션 타임아웃 설정 (무제한)
    await page.setDefaultNavigationTimeout(0);

    // 기존 매장 데이터 로드
    const INPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'citeezon_stores.json');
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'citeezon_stores_detailed.json');

    if (!await fs.pathExists(INPUT_FILE)) {
        logError(`입력 파일 "${INPUT_FILE}"이 존재하지 않습니다.`);
        await browser.close();
        throw new Error(`입력 파일 "${INPUT_FILE}"이 존재하지 않습니다.`);
    }

    let stores = await fs.readJson(INPUT_FILE);

    // 상세 정보가 이미 추가된 매장은 건너뛰기
    if (await fs.pathExists(OUTPUT_FILE)) {
        const existingDetailedData = await fs.readJson(OUTPUT_FILE);
        const existingLinks = new Set(existingDetailedData.map(store => store.link));
        stores = stores.filter(store => !existingLinks.has(store.link));
    }

    // 데이터 저장을 위한 배열 초기화 또는 기존 데이터 로드
    let allStores = [];
    if (await fs.pathExists(OUTPUT_FILE)) {
        try {
            const existingData = await fs.readJson(OUTPUT_FILE);
            allStores = existingData;
            logInfo(`기존 상세 데이터 로드 완료: 총 ${allStores.length}개의 매장`);
        } catch (err) {
            logError(`기존 상세 데이터 파일 읽기 오류: ${err.message}`);
        }
    }

    try {
        for (let i = currentIndex; i < stores.length; i++) {
            const store = stores[i];
            logInfo(`\n=== 매장 ${i + 1} / ${stores.length} ===`);
            logInfo(`상호명: ${store.상호명}, 링크: ${store.link}`);

            const detailUrl = `http://www.citeezon.co.kr${store.link}`;

            // 중단 신호 확인
            if (stopSignal()) {
                logInfo(`${scraperName} 스크래핑 중단 신호 수신. 현재 진행 상태 저장.`);
                await saveProgress(scraperName, { currentIndex: i });
                await browser.close();
                return; // 스크래핑 중단
            }

            let retries = 0;
            let success = false;

            while (retries < 3 && !success) {
                try {
                    await page.goto(detailUrl, { waitUntil: 'networkidle2' });
                    logInfo(`매장 상세 페이지에 접속 완료: ${detailUrl}`);

                    // 매장 상세 정보가 로드될 때까지 대기
                    await page.waitForSelector('tbody');

                    // 상세 정보 추출
                    const detailedInfo = await page.$$eval('tbody tr', trs => {
                        const info = {};
                        trs.forEach(tr => {
                            const tds = tr.querySelectorAll('td');
                            if (tds.length < 2) return;

                            // 비전룸, 스크린룸 등의 정보 추출
                            for (let j = 0; j < tds.length; j += 3) { // assuming pattern: head, sub, empty
                                const headTd = tds[j];
                                const subTd = tds[j + 1];

                                if (!headTd || !subTd) continue;

                                // 룸 이름 추출
                                let roomName = headTd.querySelector('span')?.innerText.trim() || '';
                                if (!roomName) {
                                    roomName = headTd.querySelector('img + span')?.innerText.trim() || '';
                                }

                                // 룸 정보 추출
                                let roomInfo = subTd.querySelector('div')?.innerText.trim() || '';

                                if (roomName) {
                                    info[roomName] = roomInfo;
                                }
                            }

                            // 아카데미, 그늘집 등의 추가 정보 추출
                            const otherHeadTd = tr.querySelector('td.shop_view_info_head.cursor_pnt');
                            const otherSubTd = tr.querySelector('td.shop_view_info_sub.txt_bk5');

                            if (otherHeadTd && otherSubTd) {
                                let featureName = otherHeadTd.querySelector('span')?.innerText.trim() || '';
                                if (!featureName) {
                                    featureName = otherHeadTd.querySelector('img + span')?.innerText.trim() || '';
                                }

                                let featureStatus = otherSubTd.querySelector('div')?.innerText.trim() || '';

                                if (featureName) {
                                    info[featureName] = featureStatus;
                                }
                            }
                        });
                        return info;
                    });

                    // 상세 정보가 없는 경우 빈 객체
                    const shopDetailedInfo = detailedInfo || {};

                    // 매장 데이터에 상세 정보 추가
                    const detailedStore = {
                        ...store,
                        상세정보: shopDetailedInfo
                    };

                    // 데이터 추가
                    allStores.push(detailedStore);
                    logInfo(`상세정보: ${JSON.stringify(shopDetailedInfo)}`);

                    // 데이터 저장
                    await fs.writeJson(OUTPUT_FILE, allStores, { spaces: 2 });
                    logInfo(`현재까지 총 ${allStores.length}개의 매장이 저장되었습니다.`);

                    // 진행 상태 업데이트
                    await saveProgress(scraperName, { currentIndex: i + 1 });
                    logInfo(`진행 상태를 저장했습니다: 다음 인덱스 = ${i + 1}`);

                    // 성공적으로 처리 완료
                    success = true;

                    // 서버에 부담을 주지 않도록 대기
                    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
                } catch (error) {
                    retries++;
                    logError(`매장 상세 정보 수집 중 오류 발생 (시도 ${retries}/3): ${error.message}`);
                    logError(`매장 링크: ${detailUrl}, 오류: ${error.message}`);

                    if (retries === 3) {
                        logError(`매장 상세 정보 수집 실패: ${detailUrl}. 다음 매장으로 넘어갑니다.`);
                        // 진행 상태 업데이트
                        await saveProgress(scraperName, { currentIndex: i + 1 });
                    } else {
                        logInfo('재시도합니다...');
                        // 서버에 부담을 주지 않도록 대기
                        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
                    }
                }
            }
        }

        // 스크래핑 완료 후 로그
        logInfo(`${scraperName} 스크래핑이 완료되었습니다.`);

        // 엑셀 변환 (필요 시 주석 해제)
        /*
        await convertJsonToExcel(OUTPUT_FILE, OUTPUT_EXCEL, [
            { header: '매장명', key: '상호명', width: 30 },
            { header: '주소', key: '주소', width: 50 },
            { header: '전화번호', key: 'tel', width: 20 },
            { header: '링크', key: 'link', width: 50 }
        ]);
        logInfo(`\n=== ${scraperName} 모든 매장 정보 수집 및 엑셀 변환 완료 ===`);
        */
    } catch (error) {
        logError(`오류 발생: ${error.message}`);
    } finally {
        await browser.close();
        logInfo('브라우저를 종료합니다.');
    }

    // 중복 제거 (필요 시 사용)
    // allStores = removeDuplicates(allStores);
    // logInfo(`중복된 매장을 제거했습니다. 총 매장 수: ${allStores.length}`);
}

export default scrapeCiteezenDetails;
