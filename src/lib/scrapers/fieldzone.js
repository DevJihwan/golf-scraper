// src/lib/scrapers/fieldzone.js
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
 * Fieldzone 스크래퍼 함수
 * @param {Function} logInfo - 정보 로그 함수
 * @param {Function} logWarn - 경고 로그 함수
 * @param {Function} logError - 오류 로그 함수
 */
export async function scrapeFieldzone(logInfo, logWarn, logError) {
    const scraperId = 'fieldzone';
    logInfo(`=== ${scraperId} 스크래핑 시작 ===`);
    setScraperStatus(scraperId, 'running');

    // 설정
    const BASE_URL = 'https://www.parongolf.com/store/indoor/index.asp';
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'parongolf_stores.json');
    const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)
    const CONCURRENCY_LIMIT = 5; // 동시에 처리할 매장 수 (현재 페이지당)
    const MAX_PAGE = 100; // 최대 페이지 수 (필요에 따라 조정)

    // p-limit 동적 import
    let pLimitModule;
    try {
        pLimitModule = (await import('p-limit')).default;
        logInfo(`p-limit 모듈 성공적으로 불러옴.`);
    } catch (err) {
        logError(`p-limit 모듈을 불러오는 중 오류 발생: ${err.message}`);
        setScraperStatus(scraperId, 'stopped');
        throw err;
    }

    // 진행 상태 읽기
    let progress = await readProgress(scraperId);
    let { currentPage } = progress;
    if (!currentPage) currentPage = 1; // 초기값 설정
    logInfo(`현재 진행 페이지: ${currentPage}`);

    // 데이터 저장을 위한 배열 초기화 또는 기존 데이터 로드
    let allStores = [];
    if (await fs.pathExists(OUTPUT_FILE)) {
        try {
            const existingData = await fs.readJson(OUTPUT_FILE);
            allStores = existingData;
            logInfo(`기존 데이터 로드 완료: 총 ${allStores.length}개의 매장`);
        } catch (err) {
            logError(`기존 데이터 파일 읽기 오류: ${err.message}`);
        }
    }

    // 동시성 제한 설정
    const limit = pLimitModule(CONCURRENCY_LIMIT);

    try {
        for (let pageNum = currentPage; pageNum <= MAX_PAGE; pageNum++) {
            logInfo(`\n=== 페이지 ${pageNum} ===`);

            // 중단 신호 확인
            const status = getScraperStatus(scraperId);
            if (status === 'stopped') {
                logInfo(`${scraperId} 스크래핑 중단 신호 감지. 현재 진행 상태 저장.`);
                await saveProgress(scraperId, { currentPage: pageNum });
                throw new ScraperStoppedError('스크래핑 중단');
            }

            // 페이지 URL 구성
            const url = `${BASE_URL}?Page=${pageNum}&sido=`;

            // 브라우저 및 페이지 열기
            const browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                userDataDir: path.join(os.tmpdir(), 'puppeteer-user-data')
            });
            const page = await browser.newPage();

            // 네비게이션 타임아웃 무제한 설정
            await page.setDefaultNavigationTimeout(0);

            try {
                // 페이지 열기
                await page.goto(url, { waitUntil: 'networkidle2' });
                logInfo(`페이지 ${pageNum}에 접속 완료: ${url}`);

                // 매장 리스트를 기다림
                await page.waitForSelector('ul.c_scosss', { timeout: 60000 }); // 최대 60초 대기

                // <ul class="c_scosss"> 요소 추출
                const stores = await page.$$eval('ul.c_scosss', uls => {
                    return uls.map(ul => {
                        const lis = ul.querySelectorAll('li');
                        if (lis.length < 6) return null;

                        const number = lis[0].innerText.trim();
                        const storeName = lis[1].innerText.trim();
                        const tel = lis[2].innerText.trim();
                        const address = lis[3].innerText.trim();
                        const 상세정보Elem = lis[4].querySelector('a.sangbox');
                        const 예약하기Elem = lis[5].querySelector('img');

                        // 상세정보 처리
                        let 상세정보 = '상세정보없음';
                        if (상세정보Elem) {
                            const onclickAttr = 상세정보Elem.getAttribute('onclick');
                            if (onclickAttr && onclickAttr.trim() !== "") {
                                상세정보 = onclickAttr.trim();
                            }
                        }

                        // 기기 처리
                        let 기기 = null;
                        if (예약하기Elem) {
                            const imgSrc = 예약하기Elem.getAttribute('src');
                            if (imgSrc.includes('icon_p.png')) {
                                기기 = '스윙분석기';
                            } else if (imgSrc.includes('icon_s.png')) {
                                기기 = '스크린';
                            }
                        }

                        return {
                            번호: `no.${number}`,
                            상호명: storeName,
                            tel: tel,
                            주소: address,
                            상세정보: 상세정보,
                            기기: 기기
                        };
                    }).filter(store => store !== null);
                });

                if (stores.length === 0) {
                    logInfo(`페이지 ${pageNum}에 데이터가 없습니다. 종료합니다.`);
                    await browser.close();
                    break;
                }

                logInfo(`추출된 매장 수: ${stores.length}`);

                // 매장 처리 함수
                const processStore = async (store) => {
                    // 중단 신호 확인
                    const status = getScraperStatus(scraperId);
                    if (status === 'stopped') {
                        logInfo(`${scraperId} 스크래핑 중단 신호 감지. 현재 진행 상태 저장.`);
                        await saveProgress(scraperId, { currentPage: pageNum });
                        throw new ScraperStoppedError('스크래핑 중단');
                    }

                    // 데이터 추가
                    allStores.push(store);
                    logInfo(`매장 번호: ${store.번호}, 상호명: ${store.상호명}, 전화: ${store.tel}, 주소: ${store.주소}, 상세정보: ${store.상세정보}, 기기: ${store.기기}`);

                    // 데이터 저장
                    await fs.writeJson(OUTPUT_FILE, allStores, { spaces: 2 });
                    logInfo(`현재까지 총 ${allStores.length}개의 매장이 저장되었습니다.`);

                    // 서버에 부담을 주지 않도록 대기
                    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
                };

                // 병렬로 매장 처리
                const tasks = stores.map(store => 
                    limit(() => processStore(store))
                );

                // 모든 매장 작업 완료 대기
                await Promise.all(tasks);

                // 다음 페이지로 이동을 위한 진행 상태 업데이트
                progress.currentPage = pageNum + 1;
                await saveProgress(scraperId, progress);
                logInfo(`진행 상태를 저장했습니다: 다음 페이지 = ${progress.currentPage}`);

                // 페이지 하단의 다음 페이지 링크가 있는지 확인
                const hasNextPage = await page.$(`div.c_paging a[href="?Page=${pageNum + 1}&sido="]`);
                if (!hasNextPage) {
                    logInfo(`페이지 ${pageNum} 이후에 더 이상 페이지가 없습니다. 종료합니다.`);
                    await browser.close();
                    break;
                }

                // 브라우저 닫기
                await browser.close();

                // 서버에 부담을 주지 않도록 대기
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
            } catch (error) {
                await browser.close();
                if (error instanceof ScraperStoppedError) {
                    logInfo(`${scraperId} 스크래핑이 중단되었습니다.`);
                    break;
                } else {
                    logError(`페이지 ${pageNum} 처리 중 오류 발생: ${error.message}`);
                    throw error; // 상위 catch로 오류 전파
                }
            }
        }

        if (getScraperStatus(scraperId) !== 'stopped') {
            logInfo(`\n=== ${scraperId} 모든 페이지의 데이터 수집 완료 ===`);
            // 진행 상태 파일 삭제 (수집 완료)
            const progressFilePath = path.join(process.cwd(), 'data', 'stores', `progress_${scraperId}.json`);
            if (await fs.pathExists(progressFilePath)) {
                await fs.unlink(progressFilePath);
                logInfo(`진행 상태 파일 "progress_${scraperId}.json"이 삭제되었습니다.`);
            }
            resetScraper(scraperId);
        }
    } catch(error) {
        ogError(`페이지 ${pageNum} 처리 중 오류 발생: ${error.message}`);
    }
}

export default scrapeFieldzone;
