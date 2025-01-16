// src/lib/scrapers/golfzone.js
import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { readProgress, saveProgress } from '../../utils/progressManager.js';
import { getScraperStatus } from '../scraperController.js'; // 추가

// 설정
const TARGET_URL = 'https://www.golfzon.com/shop/branch';
const OUTPUT_JSON = path.join(process.cwd(), 'data', 'stores', 'golfzone_stores.json');
//const OUTPUT_EXCEL = path.join(process.cwd(), 'data', 'excel', 'golfzone.xlsx');
const DELAY_BETWEEN_REQUESTS = 750; // 0.75초

// 대한민국의 특별시, 광역시, 도 및 시군구 목록
const regions = [
    {
        province: '서울특별시',
        districts: ['종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구', '노원구', '은평구', '서대문구', '마포구', '양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구', '강동구']
    },
    {
        province: '부산광역시',
        districts: ['중구', '서구', '동구', '영도구', '부산진구', '동래구', '남구', '북구', '해운대구', '사하구', '금정구', '강서구', '연제구', '수영구', '사상구', '기장군']
    },
    {
        province: '대구광역시',
        districts: ['중구', '동구', '서구', '남구', '북구', '수성구', '달서구', '달성군', '군위군']
    },
    {
        province: '인천광역시',
        districts: ['중구', '동구', '미추홀구', '연수구', '남동구', '부평구', '계양구', '서구', '강화군', '옹진군']
    },
    {
        province: '광주광역시',
        districts: ['동구', '서구', '남구', '북구', '광산구']
    },
    {
        province: '대전광역시',
        districts: ['동구', '중구', '서구', '유성구', '대덕구']
    },
    {
        province: '울산광역시',
        districts: ['중구', '남구', '동구', '북구', '울주군']
    },
    {
        province: '세종특별자치시',
        districts: ['세종특별자치시'] // 세종시는 시군구가 없으므로 본인이름으로 처리
    },
    {
        province: '경기도',
        districts: ['수원시', '용인시', '고양시', '화성시', '성남시', '부천시', '남양주시', '안산시', '평택시', '안양시', '시흥시', '파주시', '김포시', '의정부시', '광주시', '하남시', '광명시', '군포시', '양주시', '오산시', '이천시', '안성시', '구리시', '의왕시', '포천시', '양평군', '여주시', '동두천시', '과천시', '가평군', '연천군']
    },
    {
        province: '강원도',
        districts: ['춘천시', '원주시', '강릉시', '동해시', '태백시', '속초시', '삼척시', '홍천군', '횡성군', '영월군', '평창군', '정선군', '철원군', '화천군', '양구군', '인제군', '고성군', '양양군']
    },
    {
        province: '충청북도',
        districts: ['청주시', '충주시', '제천시', '보은군', '옥천군', '영동군', '증평군', '진천군', '괴산군', '음성군', '단양군']
    },
    {
        province: '충청남도',
        districts: ['천안시', '공주시', '보령시', '아산시', '서산시', '논산시', '계룡시', '당진시', '금산군', '부여군', '서천군', '청양군', '홍성군', '예산군', '태안군']
    },
    {
        province: '전라북도',
        districts: ['전주시', '군산시', '익산시', '정읍시', '남원시', '김제시', '완주군', '진안군', '무주군', '장수군', '임실군', '순창군', '고창군', '부안군']
    },
    {
        province: '전라남도',
        districts: ['목포시', '여수시', '순천시', '나주시', '광양시', '담양군', '곡성군', '구례군', '고흥군', '보성군', '화순군', '장흥군', '강진군', '해남군', '영암군', '무안군', '함평군', '영광군', '장성군', '완도군', '진도군', '신안군']
    },
    {
        province: '경상북도',
        districts: ['포항시', '경주시', '김천시', '안동시', '구미시', '영주시', '영천시', '상주시', '문경시', '경산시', '의성군', '청송군', '영양군', '영덕군', '청도군', '고령군', '성주군', '칠곡군', '예천군', '봉화군', '울진군', '울릉군']
    },
    {
        province: '경상남도',
        districts: ['창원시', '진주시', '통영시', '사천시', '김해시', '밀양시', '거제시', '양산시', '의령군', '함안군', '창녕군', '고성군', '남해군', '하동군', '산청군', '함양군', '거창군', '합천군']
    },
    {
        province: '제주특별자치도',
        districts: ['제주시', '서귀포시']
    }
];

// district를 key로, province를 value로 하는 매핑 객체 생성
const districtToProvinceMap = {};
regions.forEach(region => {
  region.districts.forEach(district => {
    districtToProvinceMap[district] = region.province;
  });
});

// 중복 제거 함수 (매장명 기준)
function removeDuplicates(stores) {
  const uniqueStores = [];
  const storeNames = new Set();
  for (const store of stores) {
    if (!storeNames.has(store.storeName)) {
      storeNames.add(store.storeName);
      uniqueStores.push(store);
    }
  }
  return uniqueStores;
}

// 주소 보정 함수
function correctAddress(address) {
  if (!address) return '';

  for (const [district, province] of Object.entries(districtToProvinceMap)) {
    if (address.includes(district)) {
      if (address.startsWith(province)) {
        return address;
      } else {
        return `${province} ${address}`;
      }
    }
  }

  return address;
}

// 지역구 추출 함수
function extractDistrict(address) {
  if (!address) return '';

  for (const [district] of Object.entries(districtToProvinceMap)) {
    if (address.includes(district)) {
      return district;
    }
  }

  return '지역구 정보 없음';
}

// 대기 함수
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function scrapeGolfzone(stopSignal = () => false, logInfo, logWarn, logError) {
    logInfo('=== Golfzone 스크래핑 시작 ===');

    // 지역 리스트 추출 및 지역 수
    const regionsList = regions.map(region => region.province);
    //const regionsCount = regionsList.length;

    // 진행 상태 읽기
    let progress = await readProgress('golfzone', { lastProcessedRegionIndex: 0, regionsProgress: {} });
    let { lastProcessedRegionIndex, regionsProgress } = progress;

    logInfo(`Loaded progress - lastProcessedRegionIndex: ${lastProcessedRegionIndex}, regionsProgress: ${JSON.stringify(regionsProgress)}`);

    // Chromium 실행 파일 경로 설정
    let executablePath = puppeteer.executablePath();

    if (process.env.NODE_ENV === 'production') {
      executablePath = path.join(process.cwd(), 'node_modules', 'puppeteer', '.local-chromium', 'win64-<version>', 'chrome.exe');
      // <version>을 실제 다운로드된 Chromium 버전으로 변경해야 합니다.
    }

    if (!await fs.pathExists(executablePath)) {
      logError('Chromium executable not found at:', executablePath);
      throw new Error('Chromium executable not found');
    }

    // 임시 디렉토리 사용
    const userDataDir = path.join(os.tmpdir(), 'puppeteer-user-data');

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      userDataDir: userDataDir
    });

    const page = await browser.newPage();

    // 네비게이션 타임아웃 설정 (무제한)
    await page.setDefaultNavigationTimeout(0);

    // 데이터 저장을 위한 배열 초기화 또는 파일에서 읽기
    let allStores = [];
    if (await fs.pathExists(OUTPUT_JSON)) {
      try {
        const existingData = await fs.readJson(OUTPUT_JSON);
        allStores = existingData;
        logInfo(`기존 데이터 로드 완료: 총 ${allStores.length}개의 매장`);
      } catch (err) {
        logError(`기존 데이터 파일 읽기 오류: ${err.message}`);
      }
    }

    try {
      // 타겟 URL로 이동
      await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
      logInfo(`접속 성공: ${TARGET_URL}`);

      // 팝업 닫기
      const popupCloseSelector = 'div#pop_c_1 a.pop_close';
      try {
        await page.waitForSelector(popupCloseSelector, { timeout: 5000 });
        await page.click(popupCloseSelector);
        logInfo('팝업을 닫았습니다.');
        await delay(DELAY_BETWEEN_REQUESTS);
      } catch (err) {
        logWarn('팝업이 나타나지 않았거나 이미 닫혔습니다.'+err.message);
      }

      // 검색어 초기화
      await page.evaluate(() => { document.getElementById('shopSearch').value = ''; });
      logInfo('검색어를 초기화했습니다.');
      await delay(DELAY_BETWEEN_REQUESTS);

      logInfo(`총 처리할 지역 수: ${regionsList.length}`);
      logInfo(`처리할 지역 목록: ${regionsList.join(', ')}`);

      for (let regionIndex = lastProcessedRegionIndex; regionIndex < regionsList.length; regionIndex++) {
        const region = regionsList[regionIndex];
        logInfo(`\n=== 지역: ${region} ===`);

        // 진행 상태 초기화 (새 지역 시작 시)
        let storeStartIndex = regionsProgress[regionIndex] || 0;

        logInfo(`Processing regionIndex: ${regionIndex}, storeStartIndex: ${storeStartIndex}`);

        // 검색창에 지역 입력
        await page.type('#shopSearch', region);
        logInfo(`지역 "${region}"을(를) 검색어로 입력했습니다.`);

        // 입력 확인
        const enteredValue = await page.$eval('#shopSearch', el => el.value).catch(() => 'N/A');
        logInfo(`입력된 검색어: "${enteredValue}"`);

        // 검색 버튼 클릭
        const searchButtonSelector = '#shopSearchButton'; // 실제 셀렉터로 수정 필요
        try {
          await Promise.all([
            page.click(searchButtonSelector),
            page.waitForSelector('#shopSearchList li', { timeout: 15000 })
          ]);
          logInfo(`검색 버튼을 클릭하고 결과를 기다립니다.`);
          await delay(2000);
        } catch (err) {
          logError(`검색 버튼을 찾을 수 없거나 검색 결과가 로드되지 않았습니다: ${err.message}`);
          // 진행 상태 저장 및 다음 지역으로 이동
          progress.lastProcessedRegionIndex = regionIndex + 1;
          await saveProgress('golfzone', progress);
          logInfo(`진행 상태를 저장했습니다: 다음 지역 인덱스 = ${progress.lastProcessedRegionIndex}`);
          continue; // 다음 지역으로 넘어갑니다.
        }

        // 검색 결과 수집
        const storeElements = await page.$$('#shopSearchList li');
        logInfo(`검색 결과: ${storeElements.length}개의 매장이 발견되었습니다.`);

        logInfo(`=== ${region} 지역의 매장 처리 시작 ===`);

        for (let i = storeStartIndex; i < storeElements.length; i++) {
          // 중단 신호 확인
          if (getScraperStatus('scrape_golfzone') === 'stopped') {
            logInfo('스크래핑 중단 신호 수신. 현재까지의 진행 상태 저장 후 중단합니다.');
            progress.regionsProgress[regionIndex] = i;
            await saveProgress('golfzone', progress);
            await browser.close();
            logInfo('브라우저를 종료했습니다.');
            logInfo('=== Golfzone 스크래핑 중단 ===');
            return;
        }

          try {
            const storeElement = storeElements[i];

            // 매장명 추출
            const storeName = await storeElement.$eval('.txt_shop', el => el.innerText.trim()).catch(() => 'N/A');
            if (storeName === 'N/A') {
              logWarn(`매장명 추출 실패: 매장 인덱스 = ${i}`);
              continue;
            }
            logInfo(`매장명 추출 완료: ${storeName}`);

            // 도로명 주소 추출
            const roadAddress = await storeElement.$eval('.txt_info:nth-of-type(1)', el => el.innerText.trim()).catch(() => 'N/A');

            // 지번 주소 추출
            const lotAddress = await storeElement.$eval('.txt_info:nth-of-type(2)', el => el.innerText.trim()).catch(() => 'N/A');

            // 전화번호 추출
            const tel = await storeElement.$eval('.txt_tel', el => el.innerText.trim()).catch(() => 'N/A');

            // 매장 클릭하여 상세 정보 열기
            const link = await storeElement.$('a');
            if (link) {
              await link.click();
              logInfo(`매장 "${storeName}"을(를) 클릭하여 상세 정보를 엽니다.`);
              await delay(DELAY_BETWEEN_REQUESTS);
            } else {
              throw new Error('매장 요소 내에 <a> 태그가 없습니다.');
            }

            // 상세 정보 추출
            const detailSelector = 'div.shop_map_detail_view';
            try {
              await page.waitForSelector(detailSelector, { timeout: 10000 });

              // 기기 정보 추출
              const gsText = await page.$eval('#gs_total_sys > em', el => el.innerText.trim()).catch(() => 'GS 0대');
              const twovisionText = await page.$eval('.twovision_sys_ico + dd.txt_tv', el => el.innerText.trim()).catch(() => 'TWOVISION 0대');
              const twovisionPlusText = await page.$eval('.twovisionplus_sys_ico + dd.txt_tvplus', el => el.innerText.trim()).catch(() => 'TWOVISIONPLUS 0대');
              const visionText = await page.$eval('.vision_sys_ico + dd.txt_v', el => el.innerText.trim()).catch(() => 'VISION 0대');
              const realText = await page.$eval('.real_sys_ico + dd.txt_r', el => el.innerText.trim()).catch(() => 'REAL 0대');
              const gdrText = await page.$eval('#gdr_total_sys em', el => el.innerText.trim()).catch(() => 'GDR 0대');

              // 데이터 파싱
              const GS = parseInt(gsText.replace(/GS\s*/i, '').replace(/대/i, '')) || 0;
              const TWOVISION = parseInt(twovisionText.replace(/TWOVISION\s*/i, '').replace(/대/i, '')) || 0;
              const TWOVISIONPLUS = parseInt(twovisionPlusText.replace(/TWOVISIONPLUS\s*/i, '').replace(/대/i, '')) || 0;
              const VISION = parseInt(visionText.replace(/VISION\s*/i, '').replace(/대/i, '')) || 0;
              const REAL = parseInt(realText.replace(/REAL\s*/i, '').replace(/대/i, '')) || 0;
              let GDR = 0;
              const gdrMatch = gdrText.match(/GDR\s*(\d+)대/i);
              if (gdrMatch && gdrMatch[1]) {
                GDR = parseInt(gdrMatch[1], 10);
              }

              // 지역구 추출
              const district = extractDistrict(roadAddress);

              // 데이터 추가
              const storeData = {
                storeName,
                roadAddress: correctAddress(roadAddress),
                lotAddress,
                tel,
                GS,
                TWOVISION,
                TWOVISIONPLUS,
                VISION,
                REAL,
                GDR,
                district
              };

              allStores.push(storeData);
              logInfo(`매장 정보 수집 완료: ${storeName}`);

              // 진행 상태 저장
              progress.regionsProgress[regionIndex] = i + 1;
              await saveProgress('golfzone', progress);
              logInfo(`진행 상태를 저장했습니다: regionsProgress[${regionIndex}] = ${i + 1}`);
            } catch (err) {
              logError(`상세 정보 로드 실패: ${err.message}`);
              // 진행 상태 저장 및 다음 매장으로 이동
              progress.regionsProgress[regionIndex] = i + 1;
              await saveProgress('golfzone', progress);
              logInfo(`진행 상태를 저장했습니다: regionsProgress[${regionIndex}] = ${i + 1}`);
            } finally {
              // 상세 정보 닫기 (팝업 닫기)
              const detailCloseSelector = 'div.shop_map_detail_view .btn_close';
              try {
                await page.click(detailCloseSelector);
                logInfo('상세 정보를 닫았습니다.');
                await delay(DELAY_BETWEEN_REQUESTS);
              } catch (err) {
                logError(`상세 정보 닫기 실패: ${err.message}`);
              }
            }

          } catch (err) {
            logError(`매장 처리 중 오류 발생: ${err.message}`);
            // 진행 상태 저장 및 다음 매장으로 이동
            progress.regionsProgress[regionIndex] = i + 1;
            await saveProgress('golfzone', progress);
            logInfo(`진행 상태를 저장했습니다: regionsProgress[${regionIndex}] = ${i + 1}`);
          }
        }

        logInfo(`=== ${region} 지역의 매장 처리 완료 ===`);

        // 검색어 초기화
        await page.evaluate(() => { document.getElementById('shopSearch').value = ''; });
        logInfo('검색어를 초기화했습니다.');
        await delay(DELAY_BETWEEN_REQUESTS);

        // 진행 상태 초기화 (다음 지역)
        progress.lastProcessedRegionIndex = regionIndex + 1;
        await saveProgress('golfzone', progress);
        logInfo(`다음 지역을 위해 진행 상태를 초기화했습니다: 다음 지역 인덱스 = ${progress.lastProcessedRegionIndex}`);
      }

      // 중복 제거
      allStores = removeDuplicates(allStores);
      logInfo(`중복된 매장을 제거했습니다. 총 매장 수: ${allStores.length}`);

      // 최종 데이터 저장
      try {
        await fs.writeJson(OUTPUT_JSON, allStores, { spaces: 2 });
        logInfo(`최종 데이터를 파일에 저장했습니다: ${OUTPUT_JSON}`);
      } catch (err) {
        logError(`데이터 파일 저장 오류: ${err.message}`);
      }

      await browser.close();
      logInfo('브라우저를 종료했습니다.');

      logInfo('=== Golfzone 스크래핑 종료 ===');
    } catch(err){
      logError(`데이터 파일 저장 오류: ${err.message}`);
    }
}
