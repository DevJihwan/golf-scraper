// src/lib/scrapers/thekgolf.js
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { load } from 'cheerio';
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
 * TheKgolf 상세 스크래퍼 함수
 * @param {Function} logInfo - 정보 로그 함수
 * @param {Function} logWarn - 경고 로그 함수
 * @param {Function} logError - 오류 로그 함수
 */
export async function scrapeTheKgolf(logInfo, logWarn, logError) {
    const scraperId = 'thekgolf';
    logInfo(`=== ${scraperId} 스크래핑 시작 ===`);
    setScraperStatus(scraperId, 'running');

    // 설정
    const BASE_URL = 'https://www.thekgolf.com/shop';
    const INPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'thekgolf_shops.json');
    const OUTPUT_FILE = path.join(process.cwd(), 'data', 'stores', 'thekgolf_stores_detailed.json');
    const DELAY_BETWEEN_REQUESTS = 1000; // 요청 사이의 대기 시간 (밀리초)

    // sleep 함수 추가
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 진행 상태 읽기
    let progress = await readProgress(scraperId);
    let { currentShopIndex } = progress;
    if (currentShopIndex === undefined) currentShopIndex = 0; // 초기값 설정

    logInfo(`현재 진행 매장 인덱스: ${currentShopIndex}`);

    // 입력 파일 존재 여부 확인
    if (!await fs.pathExists(INPUT_FILE)) {
        logError(`입력 파일이 존재하지 않습니다: ${INPUT_FILE}`);
        setScraperStatus(scraperId, 'stopped');
        throw new Error(`입력 파일이 존재하지 않습니다: ${INPUT_FILE}`);
    }

    // 입력 파일 읽기
    let shops = [];
    try {
        shops = await fs.readJson(INPUT_FILE);
        logInfo(`입력 파일에서 ${shops.length}개의 매장 데이터를 불러왔습니다.`);
    } catch (err) {
        logError(`입력 파일 읽기 오류: ${err.message}`);
        setScraperStatus(scraperId, 'stopped');
        throw err;
    }

    // 데이터 저장을 위한 배열 초기화 또는 기존 데이터 로드
    let detailedShops = [];
    if (await fs.pathExists(OUTPUT_FILE)) {
        try {
            const existingData = await fs.readJson(OUTPUT_FILE);
            detailedShops = existingData;
            logInfo(`기존 상세 데이터 로드 완료: 총 ${detailedShops.length}개의 매장`);
        } catch (err) {
            logError(`기존 상세 데이터 파일 읽기 오류: ${err.message}`);
        }
    }

    // 데이터 저장을 위한 디렉토리 확인 및 생성
    await fs.ensureDir(path.dirname(OUTPUT_FILE));

    try {
        for (let shopIndex = currentShopIndex; shopIndex < shops.length; shopIndex++) {
            const shop = shops[shopIndex];
            logInfo(`\n=== 매장 ${shopIndex + 1}/${shops.length}: ID = ${shop.shopId} ===`);

            // 중단 신호 확인
            const status = getScraperStatus(scraperId);
            if (status === 'stopped') {
                logInfo(`${scraperId} 스크래핑 중단 신호 감지. 현재 진행 상태 저장.`);
                await saveProgress(scraperId, { currentShopIndex: shopIndex });
                resetScraper(scraperId); // 상태 초기화
                throw new ScraperStoppedError('스크래핑 중단');
            }

            if (!shop.shopId) {
                logWarn(`매장 ID가 없어 상세 정보를 수집할 수 없습니다: ${shop.name}`);
                continue; // 다음 매장으로 넘어감
            }

            try {
                logInfo(`매장 ID ${shop.shopId}의 상세 정보 가져오는 중...`);

                // POST 요청으로 상세 정보 가져오기
                const postData = new URLSearchParams({ ShopIdx: shop.shopId }).toString();

                const response = await axios.post('https://www.thekgolf.com/main/ajax_shop_detail', postData, {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': BASE_URL,
                    },
                });

                if (response.data && response.data.shopDetail) {
                    const shopDetailHtml = response.data.shopDetail;

                    // cheerio로 HTML 파싱
                    const $ = load(shopDetailHtml); // load 함수 사용

                    // 센서 정보 추출
                    const sensors = [];
                    $('ul.sensor > li').each((index, element) => {
                        const sensorName = $(element).find('span').eq(0).text().trim();
                        const sensorCount = $(element).find('span').eq(1).text().trim();
                        sensors.push({ sensorName, sensorCount });
                    });

                    // 추가 데이터 저장
                    const detailedShop = {
                        ...shop,
                        sensors, // 센서 정보 추가
                        // 필요한 다른 상세 정보도 추가 가능
                    };
                    detailedShops.push(detailedShop);

                    logInfo(`매장 ID ${shop.shopId}의 상세 정보 수집 완료.`);

                    // 실시간 데이터 저장
                    try {
                        await fs.writeJson(OUTPUT_FILE, detailedShops, { spaces: 2 });
                        logInfo(`현재까지 총 ${detailedShops.length}개의 상세 매장이 저장되었습니다.`);
                    } catch (writeError) {
                        logError(`상세 데이터 저장 오류: ${writeError.message}`);
                    }
                } else {
                    logWarn(`매장 ID ${shop.shopId}의 상세 정보가 없습니다.`);
                }

                // 서버에 부담을 주지 않도록 대기
                await sleep(DELAY_BETWEEN_REQUESTS);
            } catch (error) {
                logError(`매장 ID ${shop.shopId}의 상세 정보 수집 실패: ${error.message}`);
                // 진행 상태 저장
                await saveProgress(scraperId, { currentShopIndex: shopIndex });
                // 다음 매장으로 넘어감
                continue;
            }

            // 진행 상태 업데이트
            await saveProgress(scraperId, { currentShopIndex: shopIndex + 1 });
        }

        logInfo(`\n총 수집된 상세 매장 수: ${detailedShops.length}`);

        // 데이터 최종 저장
        try {
            await fs.writeJson(OUTPUT_FILE, detailedShops, { spaces: 2 });
            logInfo(`모든 상세 매장 데이터를 ${OUTPUT_FILE} 파일에 저장했습니다.`);
        } catch (writeError) {
            logError(`최종 상세 데이터 저장 오류: ${writeError.message}`);
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
    }

    logInfo(`=== ${scraperId} 스크래핑 종료 ===`);
}

export default scrapeTheKgolf;
