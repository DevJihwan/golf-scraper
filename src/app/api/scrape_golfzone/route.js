// src/app/api/scrape_golfzone/route.js
import { scrapeGolfzone } from '../../../lib/scrapers/golfzone.js';
import { setScraperStatus } from '../../../lib/scraperController.js';

export async function GET(request) {
    // SSE 헤더 설정
    const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            // 로그 함수 정의: 로그를 SSE 이벤트로 전송
            const logInfo = (message) => {
                const data = `event: log\ndata: ${JSON.stringify({ level: 'INFO', message })}\n\n`;
                controller.enqueue(encoder.encode(data));
            };
            const logWarn = (message) => {
                const data = `event: log\ndata: ${JSON.stringify({ level: 'WARN', message })}\n\n`;
                controller.enqueue(encoder.encode(data));
            };
            const logError = (message) => {
                const data = `event: log\ndata: ${JSON.stringify({ level: 'ERROR', message })}\n\n`;
                controller.enqueue(encoder.encode(data));
            };

            // 스크래퍼 상태를 'running'으로 설정
            setScraperStatus('scrape_golfzone', 'running');

            try {
                await scrapeGolfzone(() => false, logInfo, logWarn, logError);
                // 스크래핑 완료 이벤트 전송
                const endData = `event: end\ndata: ${JSON.stringify({ message: '스크래핑 완료' })}\n\n`;
                controller.enqueue(encoder.encode(endData));
            } catch (error) {
                // 오류 발생 시 오류 이벤트 전송
                const errorData = `event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`;
                controller.enqueue(encoder.encode(errorData));
            } finally {
                // 스크래퍼 상태를 'idle'로 설정
                setScraperStatus('scrape_golfzone', 'idle');
                controller.close();
            }
        },
    });

    return new Response(stream, { headers });
}

// POST 요청으로 중단 신호를 받는 라우트 추가
export async function POST(request) {
    const { action } = await request.json();

    if (action === 'stop') {
        setScraperStatus('scrape_golfzone', 'stopped');
        return new Response(JSON.stringify({ message: '스크래핑 중단 신호가 전송되었습니다.' }), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    return new Response(JSON.stringify({ message: '유효하지 않은 요청입니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
    });
}
