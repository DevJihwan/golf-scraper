// src/app/api/scrape_friendgolf_details/route.js
import { scrapeFriendgolfDetails } from '../../../lib/scrapers/friendgolf_details.js';

export async function GET(request) {
    try {
        const { detailedShops } = await scrapeFriendgolfDetails();
        return new Response(JSON.stringify({ data: detailedShops }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    } catch (error) {
        console.error('FriendGolf 상세 스크래핑 오류:', error);
        return new Response(JSON.stringify({ error: '스크래핑 상세 실패', details: error.message }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }
}
