// src/lib/scrapers/friendgolf.js
import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { readProgress, saveProgress } from '../../utils/progressManager.js';
import { getScraperStatus, setScraperStatus, resetScraper } from '../scraperController.js';

/**
 * 커스텀 에러 클래스 정의
 */
class ScraperStoppedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScraperStoppedError';
    }
}

/**
 * FriendGolf 스크래퍼 함수
 * @param {Function} logInfo - 정보 로그 함수
 * @param {Function} logWarn - 경고 로그 함수
 * @param {Function} logError - 오류 로그 함수
 */
export async function scrapeFriendgolf(logInfo, logWarn, logError) {
    const scraperId = 'friendgolf';
    logInfo(`=== ${scraperId} 스크래핑 시작 ===`);
    setScraperStatus(scraperId, 'running');

    // 설정
    const BASE_URL = 'https://www.friendsscreen.kr/main/shop';
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'friendgolf_shops.json');
    const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)
    const MAX_PAGE = 100; // 최대 페이지 수 (필요에 따라 조정)

    // 대한민국의 특별시, 광역시, 도 및 시군구 목록
    const regions = [
        {
            province: '서울특별시',
            districts: ['종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구', '노원구', '은평구', '서대문구', '마포구', '양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구', '강동구']
        },
        // ... (다른 지역 목록 생략)
    ];

    // sleep 함수 추가
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 진행 상태 읽기
    let progress = await readProgress(scraperId);
    let { currentRegionIndex, currentPageIndex } = progress;
    if (currentRegionIndex === undefined) currentRegionIndex = 0; // 초기값 설정
    if (currentPageIndex === undefined) currentPageIndex = 0;

    logInfo(`현재 진행 지역 인덱스: ${currentRegionIndex}, 페이지 인덱스: ${currentPageIndex}`);

    // 데이터 저장을 위한 배열 초기화 또는 기존 데이터 로드
    let allShops = [];
    if (await fs.pathExists(OUTPUT_FILE)) {
        try {
            const existingData = await fs.readJson(OUTPUT_FILE);
            allShops = existingData;
            logInfo(`기존 데이터 로드 완료: 총 ${allShops.length}개의 매장`);
        } catch (err) {
            logError(`기존 데이터 파일 읽기 오류: ${err.message}`);
        }
    }

    // 브라우저 인스턴스 생성
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        userDataDir: path.join(os.tmpdir(), 'puppeteer-user-data') // 서버리스 환경에 적합한 임시 디렉토리
    });
    const page = await browser.newPage();

    try {
        for (let regionIndex = currentRegionIndex; regionIndex < regions.length; regionIndex++) {
            const region = regions[regionIndex];
            const province = region.province;
            const districts = region.districts;

            logInfo(`\n=== ${province} 검색 시작 ===`);

            for (let pageIndex = currentPageIndex; pageIndex < districts.length; pageIndex++) {
                const district = districts[pageIndex];
                logInfo(`\n=== ${province} - ${district} 검색 페이지 ${pageIndex + 1} ===`);

                // 중단 신호 확인
                const status = getScraperStatus(scraperId);
                if (status === 'stopped') {
                    logInfo(`${scraperId} 스크래핑 중단 신호 감지. 현재 진행 상태 저장.`);
                    await saveProgress(scraperId, { currentRegionIndex: regionIndex, currentPageIndex: pageIndex });
                    resetScraper(scraperId); // 상태 초기화
                    throw new ScraperStoppedError('스크래핑 중단');
                }

                try {
                    logInfo(`매장 페이지로 이동 중: ${BASE_URL}`);
                    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

                    // 검색 타입을 주소로 설정
                    logInfo('검색 타입을 주소로 설정 중...');
                    await page.select('#search_type', 'address'); // 검색 타입 설정

                    logInfo(`검색어 입력: ${district}`);
                    // 검색어 입력 (입력 필드 초기화)
                    await page.evaluate(() => {
                        const searchInput = document.querySelector('#search_word');
                        if (searchInput) {
                            searchInput.value = '';
                        }
                    });
                    await page.type('#search_word', district);

                    logInfo('검색 실행 중...');
                    // 'Enter' 키로 검색 실행 후 특정 셀렉터가 로드될 때까지 대기
                    await page.keyboard.press('Enter');
                    try {
                        await page.waitForSelector('#shopList > li', { timeout: 60000 }); // 60초까지 대기
                        logInfo('검색 결과가 로드되었습니다.');
                    } catch (navError) {
                        logError(`검색 결과가 로드되지 않았습니다: ${district}`+navError.message);
                        continue; // 다음 페이지로 넘어감
                    }

                    // 초기 데이터 수집
                    logInfo('초기 매장 데이터 추출 중...');
                    let shops = await page.evaluate(() => {
                        const shopElements = document.querySelectorAll('#shopList > li');

                        return Array.from(shopElements).map(shop => {
                            const name = shop.querySelector('.title')?.textContent.trim() || null;
                            const address = shop.querySelector('.address')?.textContent.trim() || null;
                            const tel = shop.querySelector('a.tel')?.textContent.trim() || null;

                            // onclick 속성에서 shop_detail ID 추출
                            const onclickAttr = shop.getAttribute('onclick') || '';
                            const match = onclickAttr.match(/shop_detail\((\d+)\)/);
                            const shopId = match ? match[1] : null;

                            return { name, address, tel, shopId };
                        });
                    });

                    logInfo(`초기 매장 수: ${shops.length}`);
                    allShops.push(...shops);

                    // 실시간 데이터 저장
                    try {
                        await fs.writeJson(OUTPUT_FILE, allShops, { spaces: 2 });
                        logInfo(`현재까지 총 ${allShops.length}개의 매장이 저장되었습니다.`);
                    } catch (writeError) {
                        logError(`데이터 저장 오류: ${writeError.message}`);
                    }

                    // "더보기" 버튼 클릭 루프
                    while (true) {
                        const moreButton = await page.$('#moreBtn');
                        if (moreButton) {
                            const isVisible = await page.evaluate((btn) => {
                                const rect = btn.getBoundingClientRect();
                                return rect.width > 0 && rect.height > 0; // 버튼이 화면에 표시되는지 확인
                            }, moreButton);

                            if (isVisible) {
                                try {
                                    logInfo('"더보기" 버튼 클릭 중...');
                                    await moreButton.click();
                                    await sleep(2000); // 데이터 로드 대기

                                    // 새로 로드된 데이터 추가
                                    const newShops = await page.evaluate(() => {
                                        const shopElements = document.querySelectorAll('#shopList > li');

                                        return Array.from(shopElements).map(shop => {
                                            const name = shop.querySelector('.title')?.textContent.trim() || null;
                                            const address = shop.querySelector('.address')?.textContent.trim() || null;
                                            const tel = shop.querySelector('a.tel')?.textContent.trim() || null;

                                            // onclick 속성에서 shop_detail ID 추출
                                            const onclickAttr = shop.getAttribute('onclick') || '';
                                            const match = onclickAttr.match(/shop_detail\((\d+)\)/);
                                            const shopId = match ? match[1] : null;

                                            return { name, address, tel, shopId };
                                        });
                                    });

                                    logInfo(`추가 매장 수: ${newShops.length}`);
                                    // 기존 매장과 중복되지 않도록 필터링
                                    const existingShopIds = new Set(allShops.map(shop => shop.shopId));
                                    const uniqueNewShops = newShops.filter(shop => shop.shopId && !existingShopIds.has(shop.shopId));
                                    allShops.push(...uniqueNewShops);

                                    // 실시간 데이터 저장
                                    try {
                                        await fs.writeJson(OUTPUT_FILE, allShops, { spaces: 2 });
                                        logInfo(`현재까지 총 ${allShops.length}개의 매장이 저장되었습니다.`);
                                    } catch (writeError) {
                                        logError(`데이터 저장 오류: ${writeError.message}`);
                                    }
                                } catch (error) {
                                    logError('"더보기" 버튼 클릭 실패. 재시도...' + error.message);
                                    await sleep(1000); // 실패 시 대기 후 재시도
                                }
                            } else {
                                logInfo('"더보기" 버튼이 더 이상 보이지 않습니다. 다음 지역으로 이동.');
                                break;
                            }
                        } else {
                            logInfo('"더보기" 버튼을 찾을 수 없습니다. 모든 데이터가 로드된 것으로 간주.');
                            break;
                        }

                        // 중단 신호 다시 확인
                        const statusInner = getScraperStatus(scraperId);
                        if (statusInner === 'stopped') {
                            logInfo(`${scraperId} 스크래핑 중단 신호 감지. 현재 진행 상태 저장.`);
                            await saveProgress(scraperId, { currentRegionIndex: regionIndex, currentPageIndex: pageIndex });
                            resetScraper(scraperId); // 상태 초기화
                            throw new ScraperStoppedError('스크래핑 중단');
                        }
                    }

                    logInfo(`${province} - ${district}의 모든 매장을 수집했습니다.`);
                    // 각 province마다 잠시 대기
                    await sleep(1000);

                    // 진행 상태 업데이트
                    currentPageIndex = pageIndex + 1;
                    await saveProgress(scraperId, { currentRegionIndex: regionIndex, currentPageIndex: pageIndex + 1 });
                } catch (error) {
                    if (error instanceof ScraperStoppedError) {
                        logInfo(`${scraperId} 스크래핑이 중단되었습니다.`);
                        break;
                    } else {
                        logError(`지역 ${province} - ${district} 처리 중 오류 발생: ${error.message}`);
                        // 진행 상태 저장
                        await saveProgress(scraperId, { currentRegionIndex: regionIndex, currentPageIndex: pageIndex });
                        // 다음 지역으로 넘어감
                        continue;
                    }
                }
            }

            logInfo(`\n총 수집된 매장 수: ${allShops.length}`);

            // 중복 제거 (shopId 기준)
            const uniqueShopsMap = new Map();
            allShops.forEach(shop => {
                if (shop.shopId && !uniqueShopsMap.has(shop.shopId)) {
                    uniqueShopsMap.set(shop.shopId, shop);
                }
            });
            const uniqueShops = Array.from(uniqueShopsMap.values());

            logInfo(`중복 제거 후 매장 수: ${uniqueShops.length}`);

            // 데이터 최종 저장
            try {
                await fs.writeJson(OUTPUT_FILE, uniqueShops, { spaces: 2 });
                logInfo(`모든 매장 데이터를 ${OUTPUT_FILE} 파일에 저장했습니다.`);
            } catch (writeError) {
                logError(`최종 데이터 저장 오류: ${writeError.message}`);
            }
        }    

            // 스크래핑 완료 시 상태 초기화
            resetScraper(scraperId);
    } catch (error) {
        if (error instanceof ScraperStoppedError) {
            logInfo(`${scraperId} 스크래핑이 중단되었습니다.`);
            // 진행 상태 파일은 이미 저장되어 있으므로 삭제하지 않음
        } else {
            logError(`오류 발생: ${error.message}`);
            logInfo('진행 상태가 저장되었습니다. 스크래핑을 중단하거나 재개할 수 있습니다.');
            setScraperStatus(scraperId, 'stopped'); // 상태를 'stopped'로 설정
        }
    } finally {
        await browser.close();
        logInfo('브라우저를 종료했습니다.');
    }
}

export default scrapeFriendgolf;
