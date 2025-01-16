// src/app/api/scrape_friendgolf/route.js
import { scrapeFriendgolf } from '../../../lib/scrapers/friendgolf.js';

export async function GET(request) {
    try {
        const { allShops } = await scrapeFriendgolf();
        return new Response(JSON.stringify({ data: allShops }), {
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
