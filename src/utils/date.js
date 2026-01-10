/**
 * Date Formatting Utilities
 * Provides date formatting for folder naming and data logging
 */

/**
 * Format date as YYYYMMDD for folder naming
 * @param {Date} date - Date object (defaults to now)
 * @returns {string} Formatted date string
 */
function formatDateFolder(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

/**
 * Format date for display in sheets (YYYY-MM-DD HH:mm:ss)
 * @param {Date} date - Date object (defaults to now)
 * @returns {string} Formatted datetime string
 */
function formatDateTime(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Get timezone offset string (e.g., +07:00)
 * @returns {string} Timezone offset
 */
function getTimezoneOffset() {
    const offset = -new Date().getTimezoneOffset();
    const hours = Math.floor(Math.abs(offset) / 60);
    const minutes = Math.abs(offset) % 60;
    const sign = offset >= 0 ? '+' : '-';
    return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

module.exports = {
    formatDateFolder,
    formatDateTime,
    getTimezoneOffset,
};
