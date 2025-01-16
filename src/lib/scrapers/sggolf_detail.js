// src/lib/scrapers/sggolf_detail.js

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
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

/**
 * S/W 이미지 매핑 규칙
 */
const SW_IMAGE_MAPPING = {
    'course-logo-field_n1.png': '필드X 설치',
    'logo-premium.png': '프리미엄 설치',
    // 필요에 따라 추가
};

/**
 * 매장 상세 정보 수집 함수
 */
async function fetchStoreDetails(browser, store, logInfo, logWarn, logError) {
    const page = await browser.newPage();
    const storeIdMatch = store.link.match(/https:\/\/sggolf\.com\/store\/detail\/(\d+)/);
    if (!storeIdMatch) {
        logWarn(`매장 "${store.상호명}"의 링크 형식이 올바르지 않습니다: ${store.link}`);
        await page.close();
        return null; // 상세 정보 없이 반환
    }
    const storeId = storeIdMatch[1];
    const detailUrl = `https://sggolf.com/store/detail/${storeId}`;
    logInfo(`매장 "${store.상호명}" 상세 정보 수집 중: ${detailUrl}`);
    
    try {
        await retry(async () => {
            await page.goto(detailUrl, { waitUntil: 'networkidle2' });
        }, 3);
        
        // <ul class="list-line">가 로드될 때까지 대기
        await page.waitForSelector('ul.list-line', { timeout: 10000 });
        logInfo(`매장 "${store.상호명}"의 상세 정보 로드 완료`);

        // 상세 정보 추출
        const details = await page.$$eval('ul.list-line > li', listItems => {
            const detailObj = {};
            listItems.forEach(li => {
                const keyElem = li.querySelector('strong');
                const valueElems = li.querySelectorAll('span');
                if (!keyElem) return;
                const key = keyElem.innerText.trim().replace(':', '');

                // S/W 처리
                if (key === 'S/W') {
                    let swValues = [];
                    valueElems.forEach(span => {
                        const img = span.querySelector('img');
                        const text = span.innerText.trim();
                        if (img) {
                            const src = img.getAttribute('src');
                            const imageName = src.split('/').pop(); // 이미지 이름 추출
                            if (SW_IMAGE_MAPPING[imageName]) {
                                swValues.push(SW_IMAGE_MAPPING[imageName]);
                            } else {
                                swValues.push(text); // 알 수 없는 이미지
                            }
                        } else {
                            swValues.push(text);
                        }
                    });
                    detailObj['s/w'] = swValues.join(', ');
                }
                // 센서 처리 (예: 'P3+ : 26' → '26')
                else if (key === '센서') {
                    let sensorValue = '';
                    valueElems.forEach(span => {
                        const text = span.innerText.trim();
                        const match = text.match(/:(\s*)(\d+)/);
                        if (match) {
                            sensorValue = match[2];
                        }
                    });
                    detailObj['센서'] = sensorValue || (valueElems.length > 0 ? valueElems[0].innerText.trim() : '');
                }
                // 포인트 사용 처리
                else if (key === '포인트 사용') {
                    const hasPointImg = Array.from(valueElems).some(span => {
                        const img = span.querySelector('img');
                        return img && img.getAttribute('src').includes('store-opt-point.png');
                    });
                    detailObj['포인트 사용'] = hasPointImg ? '포인트 사용 가능' : '없음';
                }
                else {
                    // 기타 키는 첫 번째 span의 텍스트를 값으로 사용
                    const value = valueElems.length > 0 ? valueElems[0].innerText.trim() : '';
                    detailObj[key] = value;
                }
            });
            return detailObj;
        });

        // 상세 정보 객체를 매장 객체에 병합
        return { ...store, ...details };
    } catch (error) {
        logError(`매장 "${store.상호명}" 상세 정보 수집 중 오류 발생: ${error.message}`);
        return null; // 오류 발생 시 상세 정보 없이 반환
    } finally {
        await page.close();
    }
}

/**
 * Scraper Function
 */
export async function scrapeSggolfDetail(logInfo, logWarn, logError) {
    const scraperId = 'sggolf_detail'; // 스크래퍼 ID 설정
    logInfo(`=== ${scraperId} 스크래핑 시작 ===`);
    setScraperStatus(scraperId, 'running');

    // 설정
    const INPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'sggolf_stores.json'); // 기존 매장 데이터 파일명
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'sggolf_stores.json'); // 업데이트된 데이터를 기존 파일에 덮어씌움
    const PROGRESS_FILE = path.join(process.cwd(), 'data', 'stores', 'progress_sggolf_store_details.json'); // 진행 상태를 저장할 파일명
    const ERROR_LOG_FILE = path.join(process.cwd(), 'data', 'stores', 'error_log_sggolf_store_details.txt'); // 에러 로그 파일
    const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)
    const CONCURRENCY_LIMIT = 5; // 동시에 처리할 매장 수
    const MAX_RETRIES = 3; // 최대 재시도 횟수

    // sleep 함수 추가
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 진행 상태 읽기
    let progress = await readProgress(scraperId);
    let { completed } = progress;
    if (completed === undefined) completed = 0;

    logInfo(`이미 처리된 매장 수: ${completed}`);

    // 입력 파일 존재 여부 확인
    if (!await fs.pathExists(INPUT_FILE)) {
        logError(`입력 파일이 존재하지 않습니다: ${INPUT_FILE}`);
        throw new Error(`입력 파일이 존재하지 않습니다: ${INPUT_FILE}`);
    }

    // 데이터 로드
    let data = [];
    try {
        data = await fs.readJson(INPUT_FILE);
        logInfo(`입력 파일에서 ${data.length}개의 매장 데이터를 불러왔습니다.`);
    } catch (err) {
        logError(`입력 파일 읽기 오류: ${err.message}`);
        throw err;
    }

    // 업데이트할 매장 목록 필터링 (이미 상세 정보가 추가된 매장 제외)
    const storesToUpdate = data.slice(completed).filter(store => !store.hasOwnProperty('s/w') || !store.hasOwnProperty('센서') || !store.hasOwnProperty('포인트 사용'));

    logInfo(`업데이트할 매장 수: ${storesToUpdate.length}`);

    if (storesToUpdate.length === 0) {
        logInfo('업데이트할 매장이 없습니다.');
        return;
    }

    // 브라우저 인스턴스 생성
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        userDataDir: path.join(os.tmpdir(), 'puppeteer-user-data') // 서버리스 환경에 적합한 임시 디렉토리
    });

    // 동시성 제한 설정
    const limit = pLimit(CONCURRENCY_LIMIT);
    const mutex = new Mutex();

    try {
        // 동시성 제한을 적용하여 매장 상세 정보 수집
        const promises = storesToUpdate.map((store, index) => 
            limit(async () => {
                // 중단 신호 확인
                const status = getScraperStatus(scraperId);
                if (status === 'stopped') {
                    logInfo(`sggolf_detail 스크래핑 중단 신호 감지. 현재 진행 상태 저장 후 중단.`);
                    await saveProgress(scraperId, { completed: completed + index });
                    resetScraper(scraperId);
                    throw new ScraperStoppedError('스크래핑 중단');
                }

                logInfo(`\n=== 매장 ${completed + index + 1} / ${data.length} ===`);
                logInfo(`매장명: ${store.상호명}`);
                logInfo(`링크: ${store.link}`);

                try {
                    const updatedStore = await fetchStoreDetails(browser, store, logInfo, logWarn, logError);
                    if (updatedStore) {
                        // 매장 정보 업데이트
                        data[completed + index] = updatedStore;
                        logInfo(`매장 "${updatedStore.상호명}" 상세 정보 업데이트 완료.`);
                    } else {
                        logInfo(`매장 "${store.상호명}" 상세 정보 없이 저장 완료.`);
                    }

                    // 진행 상태 업데이트 및 저장
                    progress.completed = completed + index + 1;
                    await saveProgress(scraperId, progress);

                    // 데이터 저장
                    try {
                        await fs.writeJson(OUTPUT_FILE, data, { spaces: 2 });
                        logInfo(`현재까지 총 ${progress.completed}개의 매장이 업데이트되었습니다.`);
                    } catch (writeError) {
                        logError(`데이터 저장 오류: ${writeError.message}`);
                        await fs.appendFile(ERROR_LOG_FILE, `데이터 저장 오류: ${writeError.message}\n`);
                    }
                } catch (error) {
                    logError(`매장 "${store.상호명}" 상세 정보 수집 중 오류 발생: ${error.message}`);
                    await fs.appendFile(ERROR_LOG_FILE, `매장 링크: ${store.link}, 오류: ${error.message}\n`);
                }

                // 서버에 부담을 주지 않도록 대기
                await sleep(DELAY_BETWEEN_REQUESTS);
            })
        );

        await Promise.all(promises);

        logInfo(`\n=== 모든 매장의 상세 정보 수집 및 업데이트 완료 ===`);

        // 진행 상태 파일 삭제 (수집 완료)
        if (await fs.pathExists(PROGRESS_FILE)) {
            await fs.unlink(PROGRESS_FILE);
            logInfo(`진행 상태 파일 "${PROGRESS_FILE}"이 삭제되었습니다.`);
        }

    } catch (error) {
        if (error instanceof ScraperStoppedError) {
            logInfo(`${scraperId} 스크래핑이 중단되었습니다.`);
            // 진행 상태 파일은 이미 저장되어 있으므로 삭제하지 않음
        } else {
            logError(`상세 조회 스크래핑 중 오류 발생: ${error.message}`);
            await fs.appendFile(ERROR_LOG_FILE, `상세 조회 스크래핑 오류: ${error.message}\n`);
        }
    } finally {
        await browser.close();
        resetScraper(scraperId);
        logInfo('브라우저를 종료했습니다.');
    }
}

export default scrapeSggolfDetail;
