// src/utils/logger.js
export function logInfo(message) {
    console.log(`INFO: ${message}`);
  }
  
  export function logError(message, ...optionalParams) {
    console.error(`ERROR: ${message}`, ...optionalParams);
  }
  
  export function logWarn(message) {
    console.warn(`WARN: ${message}`);
  }
  