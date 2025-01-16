// src/app/api/scrape_citeezen_detail/route.js
import { scrapeCiteezenDetails } from '../../../lib/scrapers/citeezon_details.js';

export async function GET() {
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

            const stopSignal = () => false; // 실제 중단 로직과 연동 필요

            try {
                await scrapeCiteezenDetails(stopSignal, logInfo, logWarn, logError);
                // 스크래핑 완료 이벤트 전송
                const endData = `event: end\ndata: ${JSON.stringify({ message: '스크래핑 완료' })}\n\n`;
                controller.enqueue(encoder.encode(endData));
                controller.close();
            } catch (error) {
                // 오류 발생 시 오류 이벤트 전송
                const errorData = `event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`;
                controller.enqueue(encoder.encode(errorData));
                controller.close();
            }
        },
    });

    return new Response(stream, { headers });
}
