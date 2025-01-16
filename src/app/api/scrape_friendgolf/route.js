// src/app/api/scrape_friendgolf/route.js
import { scrapeFriendgolf } from '../../../lib/scrapers/friendgolf.js';

export async function GET() {
    // 로그 함수 정의
    const logInfo = (message) => {
        console.log(`INFO: ${message}`);
    };
    const logWarn = (message) => {
        console.warn(`WARN: ${message}`);
    };
    const logError = (message) => {
        console.error(`ERROR: ${message}`);
    };

    try {
        await scrapeFriendgolf(logInfo, logWarn, logError);
        return new Response(JSON.stringify({ message: 'FriendGolf 스크래핑이 완료되었습니다.' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    } catch (error) {
        console.error('FriendGolf 스크래핑 오류:', error);
        return new Response(JSON.stringify({ error: '스크래핑 실패', details: error.message }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }
}
