// src/lib/scrapers/publicgolf_detail.js

import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import pLimit from 'p-limit';
//import { readProgress, saveProgress } from '../../utils/progressManager.js';
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
 * Publicgolf 상세 조회 스크래퍼 함수
 * @param {Function} logInfo - 정보 로그 함수
 * @param {Function} logWarn - 경고 로그 함수
 * @param {Function} logError - 오류 로그 함수
 */
export async function scrapePublicgolfDetail(logInfo, logWarn, logError) {
    const scraperId = 'publicgcreengolf_details';
    logInfo(`=== ${scraperId} 스크래핑 시작 ===`);
    setScraperStatus(scraperId, 'running');

    // 설정
    //const BASE_URL = 'https://publicscreengolf.com/store';
    const INPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'publicgcreengolf_stores.json'); // 기존에 수집한 JSON 파일명
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'publicgcreengolf_stores_updated.json'); // 업데이트된 데이터를 저장할 파일명
    const PROGRESS_FILE = path.join(process.cwd(), 'data', 'stores', 'progress_update_publicgcreengolf_details.json'); // 진행 상태를 저장할 파일명
    const ERROR_LOG_FILE = path.join(process.cwd(), 'data', 'stores', 'error_log_update_publicgcreengolf_details.txt'); // 에러 로그 파일
    const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)
    const CONCURRENCY_LIMIT = 5; // 동시에 처리할 매장 수

    // sleep 함수 추가
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 진행 상태 읽기
    let progress = { currentIndex: 0 };
    if (await fs.pathExists(PROGRESS_FILE)) {
        try {
            progress = await fs.readJson(PROGRESS_FILE);
        } catch (err) {
            logError(`진행 상태 파일 읽기 오류: ${err.message}`);
        }
    }

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

    // 업데이트할 매장 목록 필터링 (주소 정보가 없는 매장)
    const storesToUpdate = data.filter(store => store.주소 === '주소 정보 없음' || !store.주소);

    logInfo(`총 매장 수: ${data.length}`);
    logInfo(`업데이트할 매장 수: ${storesToUpdate.length}`);

    // 만약 모든 매장이 이미 업데이트되었다면 종료
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
    //const mutex = new Mutex();

    try {
        const tasks = storesToUpdate.map((store, index) => 
            limit(async () => {
                // 중단 신호 확인
                const status = getScraperStatus(scraperId);
                if (status === 'stopped') {
                    logInfo('상세 조회 스크래핑 중단 신호를 받았습니다.');
                    throw new ScraperStoppedError('스크래핑 중단');
                }

                // 진행 상태 업데이트 (중간 저장)
                if ((progress.currentIndex + index) % 10 === 0) { // 예: 10개마다 저장
                    progress.currentIndex += index;
                    await fs.writeJson(PROGRESS_FILE, progress, { spaces: 2 });
                }

                logInfo(`\n=== 매장 ${progress.currentIndex + index + 1} / ${storesToUpdate.length} ===`);
                logInfo(`매장명: ${store.상호명}`);
                logInfo(`링크: ${store.link}`);

                try {
                    const page = await browser.newPage();
                    await page.goto(store.link, { waitUntil: 'networkidle2' });

                    // 주소 및 룸 수 추출
                    const { address, rooms } = await extractDetails(page, logInfo, logWarn, logError);

                    // 데이터 업데이트
                    store.주소 = address;
                    store.룸 = rooms;

                    logInfo(`주소: ${store.주소}`);
                    logInfo(`룸: ${store.룸}`);

                    await page.close();
                } catch (error) {
                    logError(`매장 상세 정보 수집 중 오류 발생 (${store.link}): ${error.message}`);
                    await fs.appendFile(ERROR_LOG_FILE, `매장 링크: ${store.link}, 오류: ${error.message}\n`);
                }

                // 서버에 부담을 주지 않도록 대기
                await sleep(DELAY_BETWEEN_REQUESTS);

                // 진행 상태 업데이트
                progress.currentIndex += 1;
                await fs.writeJson(PROGRESS_FILE, progress, { spaces: 2 });
            })
        );

        await Promise.all(tasks);

        // 전체 데이터 저장
        try {
            await fs.writeJson(OUTPUT_FILE, data, { spaces: 2 });
            logInfo(`\n=== 모든 매장의 상세 정보 수집 및 업데이트 완료 ===`);
        } catch (writeError) {
            logError(`데이터 저장 오류: ${writeError.message}`);
            await fs.appendFile(ERROR_LOG_FILE, `데이터 저장 오류: ${writeError.message}\n`);
        }

        // 진행 상태 파일 삭제 (모든 작업 완료)
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

export default scrapePublicgolfDetail;
