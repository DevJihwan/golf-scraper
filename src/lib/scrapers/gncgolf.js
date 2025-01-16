// src/lib/scrapers/gncgolf.js

import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';
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

const STORE_LIST_URL = 'https://www.gncgolf.com/store/store_find';
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'gncgolf_stores.jsonl');
const PROGRESS_FILE = path.join(process.cwd(), 'data', 'stores', 'progress_gncgolf.json');
const ERROR_LOG_FILE = path.join(process.cwd(), 'data', 'stores', 'error_log_gncgolf_store_details.txt');
const DELAY_BETWEEN_REQUESTS = 1000;
const CONCURRENCY_LIMIT = 5;
const MAX_RETRIES = 3;

function appendToJsonlFile(data) {
    fs.appendFileSync(OUTPUT_FILE, JSON.stringify(data) + '\n', 'utf-8');
}

async function retry(fn, retries = MAX_RETRIES, logInfo, logWarn, logError) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === retries) throw error;
            logWarn(`재시도 ${attempt}/${retries} 실패: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
        }
    }
}

async function fetchStoreDetails(store) {
    // 실제 매장 상세 정보 수집 로직 구현 필요
    // 현재는 단순히 store 객체를 반환
    return store;
}

/**
 * GncGolf 스크래퍼 함수
 * @param {Function} logInfo - 정보 로그 함수
 * @param {Function} logWarn - 경고 로그 함수
 * @param {Function} logError - 오류 로그 함수
 */
export async function scrapeGncGolf(logInfo, logWarn, logError) {
    const scraperId = 'gncgolf';
    logInfo('=== gncgolf 스크래핑 시작 ===');
    setScraperStatus(scraperId, 'running');

    await fs.ensureDir(path.dirname(OUTPUT_FILE));

    let progress = await readProgress(scraperId);
    let { completed } = progress;
    if (completed === undefined) completed = 0;

    logInfo(`현재 진행 매장 인덱스: ${completed}`);

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        userDataDir: path.join(process.cwd(), 'puppeteer')
    });
    const page = await browser.newPage();

    await page.setDefaultNavigationTimeout(0);

    let isStopping = false;
    const mutex = new Mutex();

    try {
        try {
            await page.goto(STORE_LIST_URL, { waitUntil: 'networkidle2' });
            logInfo(`매장 목록 페이지로 이동: ${STORE_LIST_URL}`);
        } catch (error) {
            logError(`매장 목록 페이지 로드 중 오류 발생: ${error.message}`);
            throw error;
        }

        let stores = [];
        try {
            await page.waitForSelector('#store_list .item-store', { timeout: 10000 });
            logInfo('매장 목록 항목이 로드되었습니다.');

            stores = await page.$$eval('#store_list .item-store', items => {
                return items.map(item => {
                    const store_seq = item.getAttribute('store_seq');
                    const storeNameElem = item.querySelector('.icon-inline.item-store-name > span');
                    const storeName = storeNameElem ? storeNameElem.innerText.trim() : '';

                    const storeInfoElem = item.querySelector('.item-store-info');
                    let 기기 = '';
                    let 주차가능여부 = '없음';
                    let 좌타석 = '없음';
                    if (storeInfoElem) {
                        const spans = storeInfoElem.querySelectorAll('span');
                        spans.forEach(span => {
                            const text = span.innerText.trim();
                            if (text.endsWith('대')) {
                                기기 = text;
                            } else if (text === '주차가능') {
                                주차가능여부 = '있음';
                            } else if (text === '좌타석') {
                                좌타석 = '있음';
                            }
                        });
                    }

                    const allThisTextSm = item.querySelectorAll('.this-text-sm');
                    let tel = '';
                    if (allThisTextSm.length >= 2) {
                        const potentialTel = allThisTextSm[1].innerText.trim();
                        const telRegex = /^\d{2,3}-\d{3,4}-\d{4}$/;
                        if (telRegex.test(potentialTel)) {
                            tel = potentialTel;
                        }
                    }

                    const addressElem = item.querySelector('.address-short');
                    const address = addressElem ? addressElem.innerText.trim() : '';

                    return {
                        store_seq: store_seq,
                        상호명: storeName,
                        주소: address,
                        tel: tel,
                        기기: 기기,
                        주차가능여부: 주차가능여부,
                        좌타석: 좌타석
                    };
                });
            });

            logInfo(`총 매장 수: ${stores.length}`);
        } catch (error) {
            logError(`매장 목록 추출 중 오류 발생: ${error.message}`);
            throw error;
        }

        const storesToProcess = stores.slice(completed);
        logInfo(`이미 처리된 매장 수: ${completed}`);
        logInfo(`남은 매장 수: ${storesToProcess.length}`);

        const limit = pLimit(CONCURRENCY_LIMIT);

        const promises = storesToProcess.map((store, index) => limit(async () => {
            const currentIndex = completed + index;

            logInfo(`\n=== 매장 ${currentIndex + 1}/${stores.length}: "${store.상호명}" ===`);

            const status = getScraperStatus(scraperId);
            if (status === 'stopped') {
                if (!isStopping) {
                    isStopping = true;
                    logInfo('스크래핑 중단 신호 감지. 현재 진행 상태 저장 후 중단.');
                    await saveProgress(scraperId, { completed: currentIndex });
                    resetScraper(scraperId);
                    throw new ScraperStoppedError('스크래핑 중단');
                }
            }

            try {
                const updatedStore = await retry(() => fetchStoreDetails(store), MAX_RETRIES, logInfo, logWarn, logError);
                if (updatedStore) {
                    appendToJsonlFile(updatedStore);
                }

                await mutex.runExclusive(async () => {
                    completed += 1;
                    await saveProgress(scraperId, { completed });
                    logInfo(`진행 상태 업데이트: ${completed}/${stores.length}`);
                });
            } catch (error) {
                if (error instanceof ScraperStoppedError) {
                    logInfo('스크래핑이 중단되었습니다.');
                    throw error;
                } else {
                    logError(`매장 "${store.상호명}" 처리 중 오류 발생: ${error.message}`);
                    await mutex.runExclusive(async () => {
                        await saveProgress(scraperId, { completed: currentIndex });
                    });
                    await fs.appendFile(ERROR_LOG_FILE, `${new Date().toISOString()} - ${error.message}\n`);
                    logInfo('진행 상태가 저장되었습니다. 다음 매장으로 넘어갑니다.');
                }
            }
        }));

        try {
            await Promise.all(promises);
            logInfo('\n=== 모든 매장의 상세 정보 수집 및 저장 완료 ===');

            if (await fs.pathExists(PROGRESS_FILE)) {
                await fs.unlink(PROGRESS_FILE);
                logInfo(`진행 상태 파일 "${PROGRESS_FILE}"이 삭제되었습니다.`);
            }
        } catch (error) {
            if (error instanceof ScraperStoppedError) {
                logInfo('스크래핑이 중단되었습니다.');
            } else {
                logError(`매장 상세 정보 수집 중 오류 발생: ${error.message}`);
                await fs.appendFile(ERROR_LOG_FILE, `${new Date().toISOString()} - ${error.message}\n`);
                logInfo('진행 상태가 저장되었습니다. 스크립트를 다시 실행하면 중단된 지점부터 이어서 작업할 수 있습니다.');
            }
        } finally {
            await browser.close();
            logInfo('브라우저를 종료했습니다.');
        }

        logInfo('=== gncgolf 스크래핑 종료 ===');
        resetScraper(scraperId);
    }catch(error) {
        logError(`매장 상세 정보 수집 중 오류 발생: ${error.message}`);
    }
}

export default scrapeGncGolf;
