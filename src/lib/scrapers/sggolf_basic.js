// src/lib/scrapers/sggolf_basic.js

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

    // sleep 함수 추가
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 재시도 함수
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
/**
 * Scraper Function
 */
export async function scrapeSggolfBasic(logInfo, logWarn, logError) {
    const scraperId = 'sggolf_basic'; // 스크래퍼 ID 설정
    logInfo(`=== ${scraperId} 스크래핑 시작 ===`);
    setScraperStatus(scraperId, 'running');

    let isStopping = false; // 중단 상태 플래그

    // 설정
    const BASE_URL = 'https://sggolf.com/store/searchList'; // 실제 매장 검색 페이지 URL로 변경
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'sggolf_stores.json');
    const PROGRESS_FILE = path.join(process.cwd(), 'data', 'stores', 'progress_sggolf_stores.json');
    const ERROR_LOG_FILE = path.join(process.cwd(), 'data', 'stores', 'error_log_sggolf_stores.txt');
    const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)
    const CONCURRENCY_LIMIT = 5; // 동시에 처리할 매장 수
    const MAX_RETRIES = 3; // 최대 재시도 횟수

    // 진행 상태 읽기
    let progress = await readProgress(scraperId);
    let { currentRegion, currentPage } = progress;
    if (currentRegion === undefined) currentRegion = 0;
    if (currentPage === undefined) currentPage = {};

    logInfo(`현재 진행 지역 인덱스: ${currentRegion}`);

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
        // 지역 목록 추출을 위해 BASE_URL로 이동
        await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
        logInfo(`BASE_URL (${BASE_URL})로 이동 완료`);

        // 지역 목록 추출
        await page.waitForSelector('#regions', { timeout: 10000 });
        logInfo(`#regions 요소 로드 완료`);

        const regions = await page.$$eval('#regions option', options => {
            return options.map(option => ({
                name: option.innerText.trim(),
                value: option.value.trim()
            })).filter(region => region.value !== '');
        });

        logInfo(`총 지역 수: ${regions.length}`);

        // 모든 지역에 대해 반복
        for (let i = currentRegion; i < regions.length; i++) {
            const region = regions[i];
            logInfo(`\n=== 지역 ${i + 1}/${regions.length}: ${region.name} ===`);

            // 중단 신호 확인
            const status = getScraperStatus(scraperId);
            if (status === 'stopped') {
                if (!isStopping) {
                    isStopping = true;
                    logInfo(`sggolf_basic 스크래핑 중단 신호 감지. 현재 진행 상태 저장 후 중단.`);
                    await saveProgress(scraperId, { currentRegion: i, currentPage });
                    resetScraper(scraperId);
                    throw new ScraperStoppedError('스크래핑 중단');
                }
            }

            // 지역을 처리하기 전에 BASE_URL로 다시 이동하여 초기 상태 복원
            await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
            logInfo(`BASE_URL로 다시 이동하여 지역 선택 초기화`);

            // 지역 선택 및 초기화, 검색
            try {
                await retry(async () => {
                    // 지역 선택
                    await page.waitForSelector('#regions');
                    await page.select('#regions', region.value);
                    logInfo(`지역 선택: ${region.name}`);

                    // 지역 선택 후 매장 리스트 업데이트 대기
                    logInfo(`지역 선택 후 매장 리스트 업데이트 대기`);
                    await page.waitForSelector('tr[name="mapList"]', { timeout: 10000 });
                    logInfo(`매장 리스트가 로드되었습니다.`);
                }, MAX_RETRIES);
            } catch (searchError) {
                logError(`검색 버튼 클릭 중 오류 발생 (${region.name}): ${searchError}`);
                continue; // 다음 지역으로 넘어감
            }

            // 현재 지역의 마지막 페이지 저장을 위한 변수
            if (!currentPage[region.value]) {
                currentPage[region.value] = 1;
            }

            let pageNum = currentPage[region.value];

            while (true) {
                logInfo(`\n--- 지역: ${region.name}, 페이지: ${pageNum} ---`);

                // 중단 신호 확인
                const currentStatus = getScraperStatus(scraperId);
                if (currentStatus === 'stopped') {
                    if (!isStopping) {
                        isStopping = true;
                        logInfo(`sggolf_basic 스크래핑 중단 신호 감지. 현재 진행 상태 저장 후 중단.`);
                        await saveProgress(scraperId, { currentRegion: i, currentPage });
                        resetScraper(scraperId);
                        throw new ScraperStoppedError('스크래핑 중단');
                    }
                }

                // 현재 페이지 번호가 1이 아니면 페이지를 선택
                if (pageNum > 1) {
                    try {
                        await retry(async () => {
                            await page.waitForSelector(`.p-num a.dev_paging:nth-child(${pageNum})`, { timeout: 10000 });
                            await page.click(`.p-num a.dev_paging:nth-child(${pageNum})`);
                            logInfo(`페이지 ${pageNum} 클릭`);
                            await page.waitForSelector('tr[name="mapList"]', { timeout: 10000 }); // 페이지가 로드될 때까지 대기
                            logInfo(`페이지 ${pageNum} 로드 완료`);
                        }, MAX_RETRIES);
                    } catch (pageClickError) {
                        logError(`페이지 ${pageNum} 클릭 중 오류 발생 (${region.name}): ${pageClickError.message}`);
                        break; // 페이지 이동 실패 시 해당 지역의 다음 지역으로 넘어감
                    }
                }

                // 매장 리스트가 로드될 때까지 대기 (이미 대기했을 수 있음)
                try {
                    await page.waitForSelector('tr[name="mapList"]', { timeout: 10000 });
                } catch (selectorError) {
                    logWarn(`매장 리스트 로드 실패 (${region.name}, 페이지: ${pageNum}): ${selectorError.message}`);
                    break; // 매장 리스트 로드 실패 시 해당 지역의 다음 지역으로 넘어감
                }

                // 매장 정보 추출
                const stores = await page.$$eval('tr[name="mapList"]', rows => {
                    return rows.map(row => {
                        const storeNameElem = row.querySelector('#storeName');
                        const infoElem = row.querySelector('.store-info');
                        const btnsElem = row.querySelector('#btns a.btn-blue');

                        const storeName = storeNameElem ? storeNameElem.innerText.replace(/<br>/g, ' ').trim() : '';
                        const address = infoElem && infoElem.querySelector('.info-addr') ? infoElem.querySelector('.info-addr').innerText.trim() : '';
                        const tel = infoElem && infoElem.querySelector('.info-tel') ? infoElem.querySelector('.info-tel').innerText.trim() : '';
                        const onclickAttr = btnsElem ? btnsElem.getAttribute('onclick') : '';
                        const linkMatch = onclickAttr.match(/go_viewPage\('(\d+)'\)/);
                        const link = linkMatch ? `https://sggolf.com/store/detail/${linkMatch[1]}` : ''; // 상세 페이지 URL 구성

                        return {
                            상호명: storeName,
                            주소: address,
                            tel: tel,
                            link: link
                        };
                    }).filter(store => store.link); // 링크가 있는 매장만 필터링
                });

                if (stores.length === 0) {
                    logInfo(`페이지 ${pageNum}에 데이터가 없습니다. 종료합니다.`);
                    break;
                }

                logInfo(`추출된 매장 수: ${stores.length}`);

                // 매장 기본 정보 수집 (상세 정보는 별도로 처리)
                const tasks = stores.map(store => 
                    limit(async () => {
                        // 중복 여부 확인 (상호명과 링크를 기준으로)
                        if (allStores.some(existingStore => existingStore.상호명 === store.상호명 && existingStore.link === store.link)) {
                            logInfo(`매장명: ${store.상호명}, 링크: ${store.link}는 이미 저장된 매장입니다. 건너뜁니다.`);
                            return;
                        }

                        // 데이터 추가
                        allStores.push(store);
                    })
                );

                await Promise.all(tasks);

                // 페이지 처리 완료 표시
                if (!progress.processedPages) {
                    progress.processedPages = {};
                }
                progress.processedPages[pageNum] = true;

                // 진행 상태 업데이트
                currentPage[region.value] = pageNum + 1;
                await saveProgress(scraperId, { currentRegion: i, currentPage });

                // 데이터 저장
                try {
                    await fs.writeJson(OUTPUT_FILE, allStores, { spaces: 2 });
                    logInfo(`현재까지 총 ${allStores.length}개의 매장이 저장되었습니다.`);
                } catch (writeError) {
                    logError(`데이터 저장 오류: ${writeError.message}`);
                    await fs.appendFile(ERROR_LOG_FILE, `데이터 저장 오류: ${writeError.message}\n`);
                }

                // 다음 페이지로 이동 가능 여부 확인
                let hasNextPage = false;
                try {
                    // '.p-num a.dev_paging' 중 텍스트가 pageNum + 1인 요소가 있는지 확인
                    hasNextPage = await page.$(`.p-num a.dev_paging:nth-child(${pageNum + 1})`) !== null;
                } catch (nextPageError) {
                    logWarn(`다음 페이지 존재 여부 확인 중 오류 (${region.name}, 페이지: ${pageNum}): ${nextPageError.message}`);
                }

                if (hasNextPage) {
                    pageNum += 1;
                    currentPage[region.value] = pageNum;
                    await saveProgress(scraperId, { currentRegion: i, currentPage });
                    // 대기
                    await sleep(DELAY_BETWEEN_REQUESTS);
                } else {
                    logInfo(`지역 ${region.name}의 모든 페이지를 수집했습니다.`);
                    break;
                }

                // 중단 신호 다시 확인
                const finalStatus = getScraperStatus(scraperId);
                if (finalStatus === 'stopped') {
                    if (!isStopping) {
                        isStopping = true;
                        logInfo(`sggolf_basic 스크래핑 중단 신호 감지. 현재 진행 상태 저장 후 중단.`);
                        await saveProgress(scraperId, { currentRegion: i, currentPage });
                        resetScraper(scraperId);
                        throw new ScraperStoppedError('스크래핑 중단');
                    }
                }
            }
        }

        logInfo(`\n=== 모든 지역의 기본 조회 데이터 수집 완료 ===`);

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

export default scrapeSggolfBasic;
