// src/lib/scrapers/publicgolf_basic.js

import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import pLimit from 'p-limit';
import { readProgress, saveProgress } from '../../utils/progressManager.js';
import { getScraperStatus, setScraperStatus, resetScraper } from '../scraperController.js';
//import { Mutex } from 'async-mutex';

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
 * Publicgolf 기본 조회 스크래퍼 함수
 * @param {Function} logInfo - 정보 로그 함수
 * @param {Function} logWarn - 경고 로그 함수
 * @param {Function} logError - 오류 로그 함수
 */
export async function scrapePublicgolfBasic(logInfo, logWarn, logError) {
    const scraperId = 'publicgcreengolf_store';
    logInfo(`=== ${scraperId} 스크래핑 시작 ===`);
    setScraperStatus(scraperId, 'running');

    let isStopping = false; // 중단 상태 플래그

    // 설정
    const BASE_URL = 'https://publicscreengolf.com/store';
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'publicgcreengolf_stores.json');
    const PROGRESS_FILE = path.join(process.cwd(), 'data', 'stores', 'progress_publicgcreengolf_store.json');
    const ERROR_LOG_FILE = path.join(process.cwd(), 'data', 'stores', 'error_log_publicgcreengolf_store.txt');
    const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)
    const CONCURRENCY_LIMIT = 5; // 동시에 처리할 매장 수
    const MAX_PAGE = 1; // 최대 페이지 수 (필요에 따라 조정)

    // sleep 함수 추가
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 진행 상태 읽기
    let progress = await readProgress(scraperId);
    let { currentPage, processedPages } = progress;
    if (currentPage === undefined) currentPage = 1; // 초기값 설정
    if (processedPages === undefined) processedPages = {};

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
    const limit = pLimit(CONCURRENCY_LIMIT);
    //const mutex = new Mutex();

    // 브라우저 인스턴스 생성
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        userDataDir: path.join(os.tmpdir(), 'puppeteer-user-data') // 서버리스 환경에 적합한 임시 디렉토리
    });
    const page = await browser.newPage();

    // 네비게이션 타임아웃 무제한 설정
    await page.setDefaultNavigationTimeout(0);

    try {
        for (let pageNum = currentPage; pageNum <= MAX_PAGE; pageNum++) {
            // 중단 신호 확인
            const status = getScraperStatus(scraperId);
            if (status === 'stopped') {
                if (!isStopping) {
                    isStopping = true;
                    logInfo(`${scraperId} 스크래핑 중단 신호 감지. 현재 진행 상태 저장 후 중단.`);
                    await saveProgress(scraperId, { currentPage: pageNum, processedPages });
                    resetScraper(scraperId);
                    throw new ScraperStoppedError('스크래핑 중단');
                }
            }

            logInfo(`\n=== 페이지 ${pageNum} ===`);

            // 페이지가 이미 처리된 경우 건너뜀
            if (processedPages[pageNum]) {
                logInfo(`페이지 ${pageNum}은 이미 처리되었습니다. 건너뜁니다.`);
                continue;
            }

            // 페이지 URL 구성
            const url = `${BASE_URL}?page=${pageNum}`;

            // 페이지 열기
            try {
                await page.goto(url, { waitUntil: 'networkidle2' });
                logInfo(`페이지 ${pageNum} 로드 완료`);
            } catch (error) {
                logError(`페이지 ${pageNum} 로드 중 오류 발생: ${error.message}`);
                await fs.appendFile(ERROR_LOG_FILE, `페이지 ${pageNum} 로드 오류: ${error.message}\n`);
                continue; // 다음 페이지로 넘어감
            }

            // 매장 리스트를 기다림
            try {
                await page.waitForSelector('ul.gall_ul li.gall_item', { timeout: 10000 });
                logInfo(`페이지 ${pageNum}의 매장 리스트 로드 완료`);
            } catch (error) {
                logError(`페이지 ${pageNum}의 매장 리스트 로드 중 오류 발생: ${error.message}`);
                await fs.appendFile(ERROR_LOG_FILE, `페이지 ${pageNum} 매장 리스트 로드 오류: ${error.message}\n`);
                continue; // 다음 페이지로 넘어감
            }

            // <li class="gall_item"> 요소 추출
            const stores = await page.$$eval('ul.gall_ul li.gall_item', items => {
                return items.map(item => {
                    const storeNameElem = item.querySelector('a.t1');
                    const locationElem = item.querySelector('a.t2');
                    const telElem = item.querySelector('span.tel a[href^="tel:"]');
                    const linkElem = storeNameElem;

                    const 상호명 = storeNameElem ? storeNameElem.innerText.trim() : '';
                    const 지역 = locationElem ? locationElem.innerText.trim() : '';
                    const fullName = `${상호명} ${지역}`.trim();
                    const tel = telElem ? telElem.innerText.trim() : '준비중';
                    const link = linkElem ? linkElem.href : '';

                    return {
                        상호명: fullName,
                        tel: tel,
                        link: link
                        // 주소는 상세 페이지에서 추출
                    };
                }).filter(store => store.link); // 링크가 있는 매장만 필터링
            });

            if (stores.length === 0) {
                logInfo(`페이지 ${pageNum}에 데이터가 없습니다. 종료합니다.`);
                break;
            }

            logInfo(`추출된 매장 수: ${stores.length}`);

            // 매장 상세 정보 수집 함수
            const collectDetail = async (store) => {
                // 중단 신호 확인
                const currentStatus = getScraperStatus(scraperId);
                if (currentStatus === 'stopped') {
                    logInfo('기본 조회 스크래핑 중단 신호를 받았습니다.');
                    throw new ScraperStoppedError('스크래핑 중단');
                }

                try {
                    const detailPage = await browser.newPage();
                    await detailPage.goto(store.link, { waitUntil: 'networkidle2' });

                    // 주소 및 룸 수 추출
                    const { address, rooms } = await extractDetails(detailPage, logInfo, logWarn, logError);

                    // 데이터 업데이트
                    store.주소 = address;
                    store.룸 = rooms;

                    logInfo(`상호명: ${store.상호명}, 전화번호: ${store.tel}, 주소: ${store.주소}, 룸: ${store.룸}, 링크: ${store.link}`);

                    await detailPage.close();
                } catch (error) {
                    logError(`매장 상세 정보 수집 중 오류 발생 (${store.link}): ${error.message}`);
                    await fs.appendFile(ERROR_LOG_FILE, `매장 링크: ${store.link}, 오류: ${error.message}\n`);
                }

                // 서버에 부담을 주지 않도록 대기
                await sleep(DELAY_BETWEEN_REQUESTS);
            };

            // 병렬로 매장 상세 정보 수집
            const tasks = stores.map(store => 
                limit(() => collectDetail(store))
            );

            await Promise.all(tasks);

            // 페이지 처리 완료 표시
            processedPages[pageNum] = true;

            // 진행 상태 업데이트
            progress.currentPage = pageNum + 1;
            progress.processedPages = processedPages;
            await saveProgress(scraperId, progress);

            // 데이터 저장
            try {
                await fs.writeJson(OUTPUT_FILE, allStores, { spaces: 2 });
                logInfo(`현재까지 총 ${allStores.length}개의 매장이 저장되었습니다.`);
            } catch (writeError) {
                logError(`데이터 저장 오류: ${writeError.message}`);
                await fs.appendFile(ERROR_LOG_FILE, `데이터 저장 오류: ${writeError.message}\n`);
            }

            // 서버에 부담을 주지 않도록 대기
            await sleep(DELAY_BETWEEN_REQUESTS);
        }

        logInfo(`\n=== 모든 페이지의 기본 조회 데이터 수집 완료 ===`);

        // 진행 상태 파일 삭제 (모든 작업 완료)
        if (await fs.pathExists(PROGRESS_FILE)) {
            await fs.unlink(PROGRESS_FILE);
            logInfo(`진행 상태 파일 "${PROGRESS_FILE}"이 삭제되었습니다.`);
        }

        await browser.close();
        resetScraper(scraperId);
        logInfo(`=== ${scraperId} 스크래핑 종료 ===`);
    }catch(error) {
        ogError(`데이터 저장 오류: ${error.message}`);
    }
}


/**
 * 매장 상세 정보 추출 함수
 * @param {puppeteer.Page} page - Puppeteer 페이지 인스턴스
 * @param {Function} logInfo - 정보 로그 함수
 * @param {Function} logWarn - 경고 로그 함수
 * @param {Function} logError - 오류 로그 함수
 * @returns {Object} - 추출된 주소와 룸 수
 */
async function extractDetails(page, logInfo, logWarn) {
    let address = '주소 정보 없음';
    let rooms = '정보 없음';

    try {
        // 주소 추출
        address = await page.evaluate(() => {
            const subContents = document.querySelectorAll('div.sub_contents');
            for (let div of subContents) {
                const title = div.querySelector('div.sub_t1');
                const content = div.querySelector('div.sub_t2');
                if (title && content && title.innerText.includes('주소')) {
                    return content.innerText.trim();
                }
            }
            return '주소 정보 없음';
        });
    } catch (err) {
        logWarn(`주소 정보를 추출할 수 없습니다: ${err.message}`);
    }

    try {
        // 룸 수 추출
        rooms = await page.evaluate(() => {
            const subContents = document.querySelectorAll('div.sub_contents');
            for (let div of subContents) {
                const title = div.querySelector('div.sub_t1');
                const content = div.querySelector('div.sub_t2');
                if (title && content && title.innerText.includes('룸')) {
                    return `${content.innerText.trim()}개`;
                }
            }
            return '정보 없음';
        });
    } catch (err) {
        logWarn(`룸 정보를 추출할 수 없습니다: ${err.message}`);
    }

    return { address, rooms };
}

export default scrapePublicgolfBasic;
