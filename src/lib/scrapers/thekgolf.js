// src/lib/scrapers/thekgolf_basic.js

import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';
import os from 'os';
import { logInfo, logError, logWarn } from '../../utils/logger.js';
import { readProgress, saveProgress } from '../../utils/progressManager.js';
import { getScraperStatus, setScraperStatus, resetScraper } from '../scraperController.js';
import { Mutex } from 'async-mutex';

/**
 * 커스텀 에러 클래스 정의
 */
class ScraperStoppedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScraperStoppedError';
    }
}

// sleep 함수 정의
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 재시도 함수
 * @param {Function} fn - 실행할 비동기 함수
 * @param {number} retries - 재시도 횟수
 * @returns {Promise<any>}
 */
async function retry(fn, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === retries) throw error;
            logWarn(`재시도 ${attempt}/${retries} 실패: ${error.message}`);
            await sleep(1000);
        }
    }
}

/**
 * Scraper Function
 */
export async function scrapeTheKgolfBasic(logInfo, logWarn, logError) {
    const scraperId = 'thekgolf_basic'; // 스크래퍼 ID 설정
    logInfo(`=== ${scraperId} 스크래핑 시작 ===`);
    setScraperStatus(scraperId, 'running');

    let isStopping = false; // 중단 상태 플래그

    // 설정
    const BASE_URL = 'https://thekgolf.com/web/pages/sub05_3.php'; // 실제 매장 검색 페이지 URL로 변경
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'thekgolf_stores.json'); // 수집된 데이터를 저장할 JSON 파일명
    const PROGRESS_FILE = path.join(process.cwd(), 'data', 'stores', 'progress_thekgolf.json'); // 진행 상태를 저장할 파일명
    const ERROR_LOG_FILE = path.join(process.cwd(), 'data', 'stores', 'error_log_thekgolf.txt'); // 에러 로그 파일
    const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)
    const MAX_PAGE = 100; // 최대 페이지 수 (필요에 따라 조정)
    const MAX_RETRIES = 3; // 최대 재시도 횟수
    const CONCURRENCY_LIMIT = 5; // 동시에 처리할 매장 수

    // 진행 상태 읽기
    let progress = await readProgress(scraperId);
    let { currentPage } = progress;
    if (currentPage === undefined) currentPage = 1;

    logInfo(`현재 진행 페이지: ${currentPage}`);

    // 데이터 저장을 위한 배열 초기화 또는 기존 데이터 로드
    let allStores = [];
    if (await fs.pathExists(OUTPUT_FILE)) {
        try {
            allStores = await fs.readJson(OUTPUT_FILE);
            logInfo(`기존 데이터 로드 완료: 총 ${allStores.length}개의 매장`);
        } catch (err) {
            logError(`기존 데이터 파일 읽기 오류: ${err.message}`);
        }
    }

    // 동시성 제한 설정
    const limit = pLimit(CONCURRENCY_LIMIT);
    const mutex = new Mutex();

    // 브라우저 인스턴스 생성
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        userDataDir: path.join(os.tmpdir(), 'puppeteer-user-data') // 서버리스 환경에 적합한 임시 디렉토리
    });
    const page = await browser.newPage();

    // 사용자 에이전트 설정 (스크래핑 차단 방지)
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');

    // 네비게이션 타임아웃 무제한 설정
    await page.setDefaultNavigationTimeout(0);

    try {
        for (let pageNum = currentPage; pageNum <= MAX_PAGE; pageNum++) {
            logInfo(`\n=== 페이지 ${pageNum} ===`);

            // 중단 신호 확인
            const status = getScraperStatus(scraperId);
            if (status === 'stopped') {
                if (!isStopping) {
                    isStopping = true;
                    logInfo(`thekgolf_basic 스크래핑 중단 신호 감지. 현재 진행 상태 저장 후 중단.`);
                    await saveProgress(scraperId, { currentPage: pageNum, processedIndexes: progress.processedIndexes });
                    resetScraper(scraperId);
                    throw new ScraperStoppedError('스크래핑 중단');
                }
            }

            // 페이지 URL 구성
            const url = `${BASE_URL}?gubun=&rows=20&search_type=&search_word=&page=${pageNum}`;

            // 페이지 열기
            try {
                await page.goto(url, { waitUntil: 'networkidle2' });
                logInfo(`페이지 ${pageNum} 로드 완료`);
            } catch (error) {
                logError(`페이지 ${pageNum} 로드 중 오류 발생: ${error.message}`);
                continue; // 다음 페이지로 넘어감
            }

            // 매장 리스트를 기다림
            try {
                await page.waitForSelector('div.store-bx table tbody', { timeout: 15000 });
                logInfo(`페이지 ${pageNum}의 테이블 로드 완료`);
            } catch (selectorError) {
                logWarn(`페이지 ${pageNum}에 매장 리스트가 로드되지 않았습니다: ${selectorError.message}`);
                logError(`페이지 ${pageNum} 매장 리스트 로드 실패: ${selectorError.message}`);
                break;
            }

            // <tbody> 내의 <tr> 요소 추출
            const stores = await page.$$eval('div.store-bx table tbody tr', trs => {
                return trs.map(tr => {
                    const tds = tr.querySelectorAll('td');
                    if (tds.length < 3) return null;

                    const 가맹점명 = tds[0].querySelector('a')?.innerText.trim() || '';
                    const 주소 = tds[1]?.innerText.trim().replace(/\s+/g, ' ') || '';
                    const 전화번호 = tds[2]?.innerText.trim() || '';

                    return {
                        가맹점명,
                        주소,
                        전화번호
                    };
                }).filter(store => store !== null);
            });

            if (stores.length === 0) {
                logInfo(`페이지 ${pageNum}에 데이터가 없습니다. 종료합니다.`);
                break;
            }

            logInfo(`추출된 매장 수: ${stores.length}`);

            // 매장 처리 및 데이터 저장
            const processStore = async (store) => {
                try {
                    // 중복 여부 확인 (가맹점명과 주소를 기준으로)
                    if (allStores.some(existingStore => existingStore.가맹점명 === store.가맹점명 && existingStore.주소 === store.주소)) {
                        logInfo(`매장명: ${store.가맹점명}과 주소: ${store.주소}는 이미 저장된 매장입니다. 건너뜁니다.`);
                        return;
                    }

                    // 데이터 추가
                    allStores.push(store);
                    logInfo(`가맹점명: ${store.가맹점명}, 주소: ${store.주소}, 전화번호: ${store.전화번호}`);
                } catch (error) {
                    logError(`매장 처리 중 오류 발생: ${error.message}`);
                }
            };

            // 병렬로 매장 처리
            const tasks = stores.map(store => limit(() => processStore(store)));

            await Promise.all(tasks);

            // 데이터 저장
            try {
                await fs.writeJson(OUTPUT_FILE, allStores, { spaces: 2 });
                logInfo(`현재까지 총 ${allStores.length}개의 매장이 저장되었습니다.`);
            } catch (writeError) {
                logError(`데이터 저장 오류: ${writeError.message}`);
            }

            // 진행 상태 업데이트
            progress.currentPage = pageNum + 1;
            await saveProgress(scraperId, { currentPage: pageNum + 1 });

            // 중단 신호 다시 확인
            const finalStatus = getScraperStatus(scraperId);
            if (finalStatus === 'stopped') {
                if (!isStopping) {
                    isStopping = true;
                    logInfo(`thekgolf_basic 스크래핑 중단 신호 감지. 현재 진행 상태 저장 후 중단.`);
                    await saveProgress(scraperId, { currentPage: pageNum + 1 });
                    resetScraper(scraperId);
                    throw new ScraperStoppedError('스크래핑 중단');
                }
            }

            // 다음 페이지로 넘어가기 전에 대기
            await sleep(DELAY_BETWEEN_REQUESTS);
        }

        logInfo(`\n=== 모든 페이지의 데이터 수집 완료 ===`);

        // 진행 상태 파일 삭제 (수집 완료)
        if (await fs.pathExists(PROGRESS_FILE)) {
            await fs.unlink(PROGRESS_FILE);
            logInfo(`진행 상태 파일 "${PROGRESS_FILE}"이 삭제되었습니다.`);
        }

        // 최종 데이터 저장
        try {
            await fs.writeJson(OUTPUT_FILE, allStores, { spaces: 2 });
            logInfo(`최종 데이터 "${OUTPUT_FILE}"에 저장되었습니다.`);
        } catch (writeError) {
            logError(`최종 데이터 저장 오류: ${writeError.message}`);
        }

        await browser.close();
        resetScraper(scraperId);
        logInfo(`=== ${scraperId} 스크래핑 종료 ===`);
    }catch(error){
        logError(`최종 데이터 저장 오류: ${error.message}`);
    }
}

export default scrapeTheKgolfBasic;
