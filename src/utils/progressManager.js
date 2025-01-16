// src/utils/progressManager.js

// 간단한 메모리 저장소 (서버리스 환경에서는 비추천)
const progressStore = {};

export async function readProgress(taskName, totalRegions) {
  if (!progressStore[taskName]) {
    progressStore[taskName] = {
      lastProcessedRegionIndex: 0,
      regionsProgress: Array(totalRegions).fill(0)
    };
  }
  return progressStore[taskName];
}

export async function saveProgress(taskName, progress) {
  progressStore[taskName] = progress;
}
