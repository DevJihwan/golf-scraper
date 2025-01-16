// src/lib/scrapers/citeezen.js
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

export async function scrapeCiteezen(stopSignal = () => false, logInfo, logWarn, logError) {
    const scraperName = 'citeezon';
    logInfo(`=== ${scraperName} 스크래핑 시작 ===`);

    // 진행 상태 읽기
    let progress = await readProgress(scraperName);
    let { currentPage } = progress;
    if (!currentPage) currentPage = 1; // 초기값 설정

    logInfo(`Loaded progress - currentPage: ${currentPage}`);

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

    // 데이터 저장을 위한 배열 초기화 또는 파일에서 읽기
    let allStores = [];
    const OUTPUT_JSON = path.join(process.cwd(), 'data', 'stores', 'citeezon_stores.json');
    const OUTPUT_EXCEL = path.join(process.cwd(), 'data', 'excel', 'citeezon.xlsx');

    if (await fs.pathExists(OUTPUT_JSON)) {
        try {
            const existingData = await fs.readJson(OUTPUT_JSON);
            allStores = existingData;
            logInfo(`기존 데이터 로드 완료: 총 ${allStores.length}개의 매장`);
        } catch (err) {
            logError(`기존 데이터 파일 읽기 오류: ${err.message}`);
        }
    }

    try {
        for (let pageNum = currentPage; pageNum <= 100; pageNum++) { // MAX_PAGE는 필요에 따라 조정
            if (stopSignal()) {
                logInfo(`${scraperName} 스크래핑 중단 신호 수신. 현재 진행 상태 저장.`);
                await saveProgress(scraperName, { currentPage: pageNum });
                await browser.close();
                return;
            }

            logInfo(`\n=== 페이지 ${pageNum} ===`);

            // 페이지 URL 구성
            const url = `http://www.citeezon.co.kr/V/sub/shop/shop.list.asp?Page=${pageNum}&sido=`;

            try {
                await page.goto(url, { waitUntil: 'networkidle2' });
                logInfo(`페이지 ${pageNum}에 접속 완료: ${url}`);

                // 매장 리스트 추출
                const stores = await page.$$eval('ul.shop_list > li', lis => {
                    return lis.map(li => {
                        const aTag = li.querySelector('a');
                        if (!aTag) return null;

                        const link = aTag.getAttribute('href') || '';

                        const shopTitle = li.querySelector('div.shop_title')?.innerText.trim() || '';
                        const shopPoint = li.querySelector('div.shop_point')?.innerText.trim() || '';
                        const 상호명 = `${shopTitle} ${shopPoint}`.trim();

                        const address = li.querySelector('div.shop_address > div.shop_info_content')?.innerHTML.replace(/<br>/g, ' ').trim() || '';
                        const tel = li.querySelector('div.shop_tel > div.shop_info_content')?.innerText.trim() || '';

                        return {
                            상호명,
                            주소: address,
                            tel,
                            link
                        };
                    }).filter(store => store !== null);
                });

                if (stores.length === 0) {
                    logInfo(`페이지 ${pageNum}에 데이터가 없습니다. 종료합니다.`);
                    break;
                }

                logInfo(`추출된 매장 수: ${stores.length}`);

                // 중복 여부 확인 및 데이터 추가
                stores.forEach(store => {
                    if (!allStores.some(existingStore => existingStore.link === store.link)) {
                        allStores.push(store);
                        logInfo(`매장 추가: ${store.상호명}`);
                    } else {
                        logInfo(`중복 매장 건너뜀: ${store.상호명}`);
                    }
                });

                // JSON 파일로 저장
                await fs.writeJson(OUTPUT_JSON, allStores, { spaces: 2 });
                logInfo(`현재까지 총 ${allStores.length}개의 매장이 저장되었습니다.`);

                // 진행 상태 저장
                await saveProgress(scraperName, { currentPage: pageNum + 1 });
                logInfo(`진행 상태를 저장했습니다: 다음 페이지 = ${pageNum + 1}`);

                // 서버에 부담을 주지 않도록 대기
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
            } catch (err) {
                logError(`페이지 ${pageNum} 스크래핑 중 오류 발생: ${err.message}`);
                // 진행 상태 저장 및 다음 페이지로 이동
                await saveProgress(scraperName, { currentPage: pageNum + 1 });
                logInfo(`진행 상태를 저장했습니다: 다음 페이지 = ${pageNum + 1}`);
            }
        }

        // 스크래핑 완료 후 로그
        logInfo(`${scraperName} 스크래핑이 완료되었습니다.`);

        // 엑셀 변환 (필요 시 주석 해제)
        /*
        await convertJsonToExcel(OUTPUT_JSON, OUTPUT_EXCEL, [
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

export default scrapeCiteezen;
