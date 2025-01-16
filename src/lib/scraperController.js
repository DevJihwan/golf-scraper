// src/lib/scraperController.js

const scraperStatus = new Map();

/**
 * Scraper의 상태를 설정합니다.
 * @param {string} scraperId - 스크래퍼의 ID
 * @param {string} status - 'running', 'stopped', 또는 'idle'
 */
export function setScraperStatus(scraperId, status) {
    scraperStatus.set(scraperId, status);
}

/**
 * Scraper의 현재 상태를 가져옵니다.
 * @param {string} scraperId - 스크래퍼의 ID
 * @returns {string} - 'running', 'stopped', 또는 'idle'
 */
export function getScraperStatus(scraperId) {
    return scraperStatus.get(scraperId) || 'idle';
}

/**
 * Scraper의 중단 신호를 설정합니다.
 * @param {string} scraperId - 스크래퍼의 ID
 */
export function stopScraper(scraperId) {
    setScraperStatus(scraperId, 'stopped');
}

/**
 * Scraper의 중단 신호를 초기화합니다.
 * @param {string} scraperId - 스크래퍼의 ID
 */
export function resetScraper(scraperId) {
    setScraperStatus(scraperId, 'idle');
}
