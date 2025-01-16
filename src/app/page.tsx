// src/app/page.tsx
'use client';

import { useState, useEffect, useRef } from 'react';

interface ScraperState {
  loading: boolean;
  error: string | null;
  logs: string[]; // Log messages
}

interface Scraper {
  id: string;
  name: string;
}

const scrapers: Scraper[] = [
  { id: 'scrape_golfzone', name: 'GolfZone' },
  { id: 'scrape_fieldzone', name: 'FieldZone' },
  { id: 'scrape_friendgolf', name: 'FriendGolf' },
  { id: 'scrape_friendgolf_details', name: 'FriendGolf Details' },
  { id: 'scrape_gncgolf', name: 'GncGolf' },
  { id: 'scrape_okongolf_store', name: 'Okongolf' },
  { id: 'scrape_publicgcreengolf_store', name: 'Publicgolf Basic' },
  { id: 'scrape_publicgcreengolf_details', name: 'Publicgolf Detail' },
  { id: 'scrape_sggolf_basic', name: 'Sggolf Basic' },
  { id: 'scrape_sggolf_detail', name: 'Sggolf Detail' },
  { id: 'scrape_thekgolf_basic', name: 'TheKgolf Basic' },
  { id: 'scrape_citeezen', name: 'Citeezen' },
  { id: 'scrape_citeezen_detail', name: 'Citeezen Detail' }
];

export default function Home() {
  // 초기 스크래퍼 상태 설정
  const initialScraperStates: { [key: string]: ScraperState } = {};
  scrapers.forEach(scraper => {
    initialScraperStates[scraper.id] = { loading: false, error: null, logs: [] };
  });

  const [scraperStates, setScraperStates] = useState<{ [key: string]: ScraperState }>(initialScraperStates);
  const [activeTab, setActiveTab] = useState<string>(scrapers[0].id); // 초기 활성 탭 설정
  const eventSourceRef = useRef<{ [key: string]: EventSource }>({});

  const handleScrape = async (scraperId: string) => {
    // Reset logs and set loading
    setScraperStates(prev => ({
      ...prev,
      [scraperId]: { ...prev[scraperId], loading: true, error: null, logs: [] },
    }));

    // Close any existing EventSource for this scraper
    if (eventSourceRef.current[scraperId]) {
      eventSourceRef.current[scraperId]?.close();
    }

    // Initialize EventSource for SSE
    const eventSource = new EventSource(`/api/${scraperId}`);
    eventSourceRef.current[scraperId] = eventSource;

    eventSource.onmessage = (event) => {
      // Handle default messages if any
      console.log('Message:', event.data);
    };

    eventSource.addEventListener('log', (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      const { level, message } = data;
      const logMessage = `${level}: ${message}`;
      setScraperStates(prev => ({
        ...prev,
        [scraperId]: { ...prev[scraperId], logs: [...prev[scraperId].logs, logMessage] },
      }));
    });

    eventSource.addEventListener('end', (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      const { message } = data;
      const logMessage = `INFO: ${message}`;
      setScraperStates(prev => ({
        ...prev,
        [scraperId]: { ...prev[scraperId], logs: [...prev[scraperId].logs, logMessage], loading: false },
      }));
      eventSource.close();
      delete eventSourceRef.current[scraperId];
    });

    eventSource.addEventListener('stop', (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      const { message } = data;
      const logMessage = `INFO: ${message}`;
      setScraperStates(prev => ({
        ...prev,
        [scraperId]: { ...prev[scraperId], logs: [...prev[scraperId].logs, logMessage], loading: false },
      }));
      eventSource.close();
      delete eventSourceRef.current[scraperId];
    });

    // 수정된 'error' 이벤트 핸들러
    eventSource.addEventListener('error', () => {
      const logMessage = `ERROR: SSE connection encountered an error.`;
      setScraperStates(prev => ({
        ...prev,
        [scraperId]: { ...prev[scraperId], loading: false, logs: [...prev[scraperId].logs, logMessage] },
      }));
      eventSource.close();
      delete eventSourceRef.current[scraperId];
    });
  };

  const handleStop = async (scraperId: string) => {
    // 중단 요청 API 호출
    try {
      const response = await fetch('/api/stop_scraper', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scraperId }),
      });

      if (!response.ok) {
        throw new Error('Failed to send stop signal');
      }

      const data = await response.json();
      console.log(data.message);
    } catch (error) {
      console.error('Error stopping scraper:', error);
    }

    // EventSource 닫기
    if (eventSourceRef.current[scraperId]) {
      eventSourceRef.current[scraperId]?.close();
      setScraperStates(prev => ({
        ...prev,
        [scraperId]: { ...prev[scraperId], loading: false },
      }));
      delete eventSourceRef.current[scraperId];
    }
  };

  const handleContinue = (scraperId: string) => {
    handleScrape(scraperId);
  };

  // Clean up EventSources on unmount
  useEffect(() => {
    return () => {
      Object.values(eventSourceRef.current).forEach(eventSource => {
        eventSource.close();
      });
    };
  }, []);

  return (
    <div className="min-h-screen bg-blue-100 p-8">
      <h1 className="text-4xl font-bold text-center text-blue-800 mb-8">웹 스크래퍼 대시보드</h1>
      
      {/* 탭 메뉴 */}
      <div className="flex flex-wrap gap-2 justify-center mb-8 overflow-x-auto">
        {scrapers.map(scraper => (
          <button
            key={scraper.id}
            onClick={() => setActiveTab(scraper.id)}
            className={`px-4 py-2 rounded-md font-semibold transition-colors duration-200 whitespace-nowrap ${
              activeTab === scraper.id
                ? 'bg-blue-600 text-white'
                : 'bg-white text-blue-600 hover:bg-blue-50'
            }`}
          >
            {scraper.name}
          </button>
        ))}
      </div>

      {/* 활성화된 탭 내용 */}
      <div className="max-w-5xl mx-auto bg-white shadow-lg rounded-lg p-6">
        {/* 스크래핑 및 중단 버튼 */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => handleScrape(activeTab)}
            disabled={scraperStates[activeTab].loading}
            className={`flex-1 py-3 px-6 rounded-md text-white font-semibold transition duration-200 ${
              scraperStates[activeTab].loading
                ? 'bg-blue-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {scraperStates[activeTab].loading ? '스크래핑 중...' : `${scrapers.find(s => s.id === activeTab)?.name} 스크래핑 시작`}
          </button>
          <button
            onClick={() => handleStop(activeTab)}
            disabled={!scraperStates[activeTab].loading}
            className={`flex-1 py-3 px-6 rounded-md text-white font-semibold transition duration-200 ${
              !scraperStates[activeTab].loading
                ? 'bg-red-400 cursor-not-allowed'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            중단
          </button>
          <button
            onClick={() => handleContinue(activeTab)}
            disabled={scraperStates[activeTab].loading}
            className={`flex-1 py-3 px-6 rounded-md text-white font-semibold transition duration-200 ${
              scraperStates[activeTab].loading
                ? 'bg-green-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-700'
            }`}
          >
            이어하기
          </button>
        </div>

        {/* 로그 표시 영역 */}
        <div className="bg-gray-100 p-4 rounded-md h-96 overflow-y-auto">
          {scraperStates[activeTab].error && (
            <p className="text-red-500">오류: {scraperStates[activeTab].error}</p>
          )}
          {scraperStates[activeTab].logs.length > 0 && (
            <div>
              {scraperStates[activeTab].logs.map((log, index) => (
                <p key={index} className={`text-sm ${log.startsWith('ERROR') ? 'text-red-500' : log.startsWith('WARN') ? 'text-yellow-500' : 'text-gray-800'}`}>
                  {log}
                </p>
              ))}
            </div>
          )}
          {!scraperStates[activeTab].loading && scraperStates[activeTab].logs.length === 0 && (
            <p className="text-gray-500">아직 스크래핑이 시작되지 않았습니다.</p>
          )}
          {scraperStates[activeTab].loading && scraperStates[activeTab].logs.length === 0 && (
            <p className="text-blue-600">스크래핑 진행 중...</p>
          )}
        </div>
      </div>
    </div>
  );
}
