// src/lib/scrapers/okongolf.js

import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
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

/**
 * Okongolf 기본 조회 스크래퍼 함수
 * @param {Function} logInfo - 정보 로그 함수
 * @param {Function} logWarn - 경고 로그 함수
 * @param {Function} logError - 오류 로그 함수
 */
export async function scrapeOkongolf(logInfo, logWarn, logError) {
    const scraperId = 'okongolf_store';
    logInfo(`=== ${scraperId} 스크래핑 시작 ===`);
    setScraperStatus(scraperId, 'running');

    let isStopping = false; // 중단 상태 플래그

    // 설정
    const BASE_URL = 'https://www.okongolf.co.kr/theongc/app/~search.php';
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'okongolf_stores.json');
    const PROGRESS_FILE = path.join(process.cwd(), 'data', 'stores', 'progress_okongolf.json');
    const ERROR_LOG_FILE = path.join(process.cwd(), 'data', 'stores', 'error_log_okongolf.txt');
    const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)
    const CONCURRENCY_LIMIT = 5; // 동시에 처리할 매장 수
    const MAX_PAGE = 2; // 최대 페이지 수 (필요에 따라 조정)

    // sleep 함수 추가
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 진행 상태 읽기
    let progress = await readProgress(scraperId);
    let { currentPage, processedIndexes } = progress;
    if (currentPage === undefined) currentPage = 1; // 초기값 설정
    if (processedIndexes === undefined) processedIndexes = {};

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
    const mutex = new Mutex();

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
                    await saveProgress(scraperId, { currentPage: pageNum, processedIndexes });
                    resetScraper(scraperId);
                    throw new ScraperStoppedError('스크래핑 중단');
                }
            }

            logInfo(`\n=== 페이지 ${pageNum} ===`);

            // 페이지 URL 구성
            const url = `${BASE_URL}?page=${pageNum}&sido=&sigungu=&search_txt=&chkswing=&chkleft=&chkca=`;

            // 페이지 열기
            try {
                await page.goto(url, { waitUntil: 'networkidle2' });
                logInfo(`페이지 ${pageNum} 로드 완료`);
            } catch (error) {
                logError(`페이지 ${pageNum} 로드 중 오류 발생: ${error.message}`);
                await fs.appendFile(ERROR_LOG_FILE, `페이지 ${pageNum} 로드 오류: ${error.message}\n`);
                continue; // 다음 페이지로 넘어감
            }

            // 테이블의 tbody를 기다림
            try {
                await page.waitForSelector('table tbody', { timeout: 10000 });
                logInfo(`페이지 ${pageNum}의 테이블 로드 완료`);
            } catch (error) {
                logError(`페이지 ${pageNum}의 테이블 로드 중 오류 발생: ${error.message}`);
                await fs.appendFile(ERROR_LOG_FILE, `페이지 ${pageNum} 테이블 로드 오류: ${error.message}\n`);
                continue; // 다음 페이지로 넘어감
            }

            // <tr> 요소 추출
            const rows = await page.$$eval('table tbody tr', (trs) => {
                return Array.from(trs).map(tr => {
                    const tds = tr.querySelectorAll('td');
                    if (tds.length < 5) return null;

                    const numberText = tds[0].innerText.trim();
                    const number = parseInt(numberText, 10);
                    if (isNaN(number)) return null; // 번호가 숫자가 아니면 스킵

                    const storeName = tds[1].innerText.trim();
                    const phoneNumber = tds[2].innerText.trim();
                    const address = tds[3].innerText.trim();

                    // 룸수 추출을 위한 이미지 src
                    const img = tds[4].querySelector('img');
                    const imgSrc = img ? img.getAttribute('src') : '';
                    return { number, storeName, phoneNumber, address, imgSrc };
                }).filter(row => row !== null);
            });

            if (rows.length === 0) {
                logInfo(`페이지 ${pageNum}에 데이터가 없습니다. 종료합니다.`);
                break;
            }

            logInfo(`추출된 매장 수: ${rows.length}`);

            // 매장 처리 함수
            const processStore = async (store, index) => {
                const storeIndex = index; // 페이지 내 매장 인덱스

                // 중단 신호 다시 확인
                const currentStatus = getScraperStatus(scraperId);
                if (currentStatus === 'stopped') {
                    if (!isStopping) {
                        isStopping = true;
                        logInfo(`${scraperId} 스크래핑 중단 신호 감지. 현재 진행 상태 저장 후 중단.`);
                        await saveProgress(scraperId, { currentPage: pageNum, processedIndexes });
                        resetScraper(scraperId);
                        throw new ScraperStoppedError('스크래핑 중단');
                    }
                }

                if (processedIndexes[pageNum] && processedIndexes[pageNum].includes(storeIndex)) {
                    logInfo(`매장 ${storeIndex + 1} (번호: ${store.number}) 이미 처리됨. 건너뜁니다.`);
                    return;
                }

                try {
                    // 원시 데이터 로깅
                    logInfo(`매장 ${storeIndex + 1} 원시 데이터:`);
                    logInfo(`  number: "${store.number}"`);
                    logInfo(`  storeName: "${store.storeName}"`);
                    logInfo(`  phoneNumber: "${store.phoneNumber}"`);
                    logInfo(`  address: "${store.address}"`);

                    // 룸수 처리
                    const roomCount = extractRoomCount(store.imgSrc);

                    // 유효한 데이터인지 확인
                    const isNumberValid = isValidNumber(store.number);
                    const isStoreNameValid = isValidStoreName(store.storeName);
                    const phoneNumberValid = isValidPhoneNumber(store.phoneNumber);
                    const isAddressValid = isValidAddress(store.address);

                    if (!isNumberValid || !isStoreNameValid || !phoneNumberValid || !isAddressValid) {
                        logInfo(`매장 ${storeIndex + 1} 데이터가 유효하지 않습니다. 건너뜁니다.`);
                        return;
                    }

                    // 상세 정보 추가
                    const detailedStore = {
                        number: store.number,
                        storeName: store.storeName,
                        phoneNumber: store.phoneNumber === "-" ? null : store.phoneNumber,
                        address: store.address,
                        roomCount: roomCount
                    };

                    allStores.push(detailedStore);
                    logInfo(`추출 완료: 룸수 - ${roomCount}`);

                    // 진행 상태 업데이트
                    if (!processedIndexes[pageNum]) {
                        processedIndexes[pageNum] = [];
                    }
                    processedIndexes[pageNum].push(storeIndex);

                    // 데이터 저장
                    try {
                        await fs.writeJson(OUTPUT_FILE, allStores, { spaces: 2 });
                        logInfo(`현재까지 총 ${allStores.length}개의 매장이 저장되었습니다.`);
                    } catch (writeError) {
                        logError(`데이터 저장 오류: ${writeError.message}`);
                        await fs.appendFile(ERROR_LOG_FILE, `데이터 저장 오류: ${writeError.message}\n`);
                    }

                    // 진행 상태 저장
                    progress.currentPage = pageNum;
                    progress.processedIndexes = processedIndexes;
                    await saveProgress(scraperId, progress);

                    // 서버에 부담을 주지 않도록 대기
                    await sleep(DELAY_BETWEEN_REQUESTS);
                } catch (error) {
                    if (error instanceof ScraperStoppedError) {
                        logInfo('스크래핑이 중단되었습니다.');
                        throw error;
                    } else {
                        logError(`매장 "${store.storeName}" 처리 중 오류 발생: ${error.message}`);
                        await mutex.runExclusive(async () => {
                            await saveProgress(scraperId, { currentPage: pageNum, processedIndexes });
                        });
                        await fs.appendFile(ERROR_LOG_FILE, `${new Date().toISOString()} - ${error.message}\n`);
                        logInfo('진행 상태가 저장되었습니다. 다음 매장으로 넘어갑니다.');
                    }
                }
            };

            // 병렬로 매장 처리
            const tasks = rows.map((store, index) => 
                limit(() => processStore(store, index))
            );

            // 모든 매장 작업 완료 대기
            await Promise.all(tasks);

            // 다음 페이지로 이동
            progress.currentPage = pageNum + 1;
            progress.processedIndexes = processedIndexes;
            await saveProgress(scraperId, progress);

            // 서버에 부담을 주지 않도록 대기
            await sleep(DELAY_BETWEEN_REQUESTS);
        }

        logInfo(`\n=== 모든 페이지의 데이터 수집 완료 ===`);

        // 진행 상태 파일 삭제 (수집 완료)
        if (await fs.pathExists(PROGRESS_FILE)) {
            await fs.unlink(PROGRESS_FILE);
            logInfo(`진행 상태 파일 "${PROGRESS_FILE}"이 삭제되었습니다.`);
        }

        await browser.close();
        logInfo('브라우저를 종료했습니다.');
        resetScraper(scraperId);

        logInfo(`=== ${scraperId} 스크래핑 종료 ===`);
    } catch(error) {
        logError(`매장 "${store.storeName}" 처리 중 오류 발생: ${error.message}`);
    }
}

/**
 * 룸수 추출 함수
 * @param {string} imgSrc - 이미지 소스 URL
 * @returns {number|null} - 룸 수 또는 null
 */
function extractRoomCount(imgSrc) {
    const regex = /new_icon2_(\d+)\.gif$/;
    const match = imgSrc.match(regex);
    if (match && match[1]) {
        return parseInt(match[1], 10);
    }
    return null;
}

/**
 * 전화번호 유효성 검사 함수
 * @param {string} phoneStr - 전화번호 문자열
 * @returns {boolean} - 유효 여부
 */
function isValidPhoneNumber(phoneStr) {
    // 전화번호가 없거나 "-"인 경우도 유효하게 처리
    if (phoneStr === "-" || phoneStr === "") {
        return true;
    }
    const regex = /^\d{2,3}-\d{3,4}-\d{4}$/;
    return regex.test(phoneStr);
}

/**
 * number 필드 유효성 검사 함수
 * @param {number} number - 번호
 * @returns {boolean} - 유효 여부
 */
function isValidNumber(number) {
    // 입력값을 문자열로 변환
    const numberStr = String(number);
    // 숫자만 추출
    const cleanedNumber = numberStr.replace(/\D/g, '');
    const regex = /^\d+$/;
    return regex.test(cleanedNumber);
}

/**
 * storeName 유효성 검사 함수
 * @param {string} nameStr - 상호명 문자열
 * @returns {boolean} - 유효 여부
 */
function isValidStoreName(nameStr) {
    return nameStr.length > 0;
}

/**
 * address 유효성 검사 함수
 * @param {string} addressStr - 주소 문자열
 * @returns {boolean} - 유효 여부
 */
function isValidAddress(addressStr) {
    return addressStr.length > 0;
}

export default scrapeOkongolf;
