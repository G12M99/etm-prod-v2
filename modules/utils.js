/**
 * @module utils
 * @description Fonctions utilitaires pures + système Toast (seule exception DOM).
 */

// ===================================
// Conversion temps
// ===================================

/**
 * Convert time to decimal hours.
 * Supports Date objects, "HH:MM:SS" strings, and numeric values.
 * @param {Date|string|number} timeStr
 * @returns {number} Decimal hours (e.g. 16.5)
 */
export function timeToDecimalHours(timeStr) {
    if (timeStr === null || timeStr === undefined || timeStr === '') return 0;

    if (timeStr instanceof Date) {
        return timeStr.getHours() + (timeStr.getMinutes() / 60) + (timeStr.getSeconds() / 3600);
    }

    if (typeof timeStr === 'string') {
        const parts = timeStr.trim().split(':');
        if (parts.length === 0) return 0;
        const hours = parseInt(parts[0]) || 0;
        const minutes = parseInt(parts[1]) || 0;
        const seconds = parseInt(parts[2]) || 0;
        return hours + (minutes / 60) + (seconds / 3600);
    }

    if (typeof timeStr === 'number') {
        if (timeStr < 1) {
            return timeStr * 24;
        }
        return timeStr;
    }

    return 0;
}

/**
 * Convert "HH:MM" string to decimal hours.
 * Lighter version of timeToDecimalHours for simple HH:MM strings.
 * @param {string} timeStr - e.g. "07:30"
 * @returns {number} e.g. 7.5
 */
export function timeStringToDecimal(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h + m / 60;
}

/**
 * Format decimal time to "HH:MM" string.
 * @param {number} decimalTime - e.g. 16.5
 * @returns {string} e.g. "16:30"
 */
export function formatDecimalTime(decimalTime) {
    const hours = Math.floor(decimalTime);
    const minutes = Math.round((decimalTime - hours) * 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Alias for formatDecimalTime (backward compatibility).
 */
export const decimalToTimeString = formatDecimalTime;

/**
 * Add hours to a "HH:MM" time string.
 * @param {string} timeStr - e.g. "07:30"
 * @param {number} hours - Hours to add (decimal)
 * @returns {string} e.g. "09:30"
 */
export function addHoursToTime(timeStr, hours) {
    const [h, m] = timeStr.split(':').map(Number);
    const totalMinutes = h * 60 + m + Math.round(hours * 60);
    const newH = Math.floor(totalMinutes / 60);
    const newM = totalMinutes % 60;
    return `${newH.toString().padStart(2, '0')}:${newM.toString().padStart(2, '0')}`;
}

// ===================================
// Dates & semaines
// ===================================

/**
 * Get ISO week number from a date.
 * @param {Date|string} date
 * @returns {number} Week number (1-53)
 */
export function getWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Get ISO week year (handles week 1 starting in previous year, etc.).
 * @param {Date|string} date
 * @returns {number} Year for the ISO week
 */
export function getISOWeekYear(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    return d.getFullYear();
}

/** @type {string[]} */
export const DAYS_OF_WEEK = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];

/**
 * Get date range (start day, end day, month label) for a given ISO week.
 * @param {number} weekNumber
 * @param {number} year - Required
 * @returns {{ start: number, end: number, month: string }}
 */
export function getWeekDateRange(weekNumber, year) {
    const simple = new Date(year, 0, 1 + (weekNumber - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = simple;
    if (dow <= 4)
        ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else
        ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

    const startDate = ISOweekStart;
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 4);

    return {
        start: startDate.getDate(),
        end: endDate.getDate(),
        month: startDate.toLocaleDateString('fr-FR', { month: 'short' })
    };
}

/**
 * Convert week/day/time to a Date object.
 * @param {number} weekNumber - ISO week number
 * @param {string} dayName - French day name (e.g. "Lundi")
 * @param {string} timeStr - "HH:MM"
 * @param {number} year - Required
 * @returns {Date}
 */
export function getDateFromWeekDay(weekNumber, dayName, timeStr, year) {
    const simple = new Date(year, 0, 1 + (weekNumber - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = new Date(simple);
    if (dow <= 4)
        ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else
        ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

    const dayIndex = DAYS_OF_WEEK.indexOf(dayName);
    const targetDate = new Date(ISOweekStart);
    targetDate.setDate(ISOweekStart.getDate() + dayIndex);

    const [hours, minutes] = timeStr.split(':');
    targetDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    return targetDate;
}

/**
 * Alias for getDateFromWeekDay with year correction.
 * @param {number} week
 * @param {string} dayName
 * @param {string} timeStr
 * @param {number} year
 * @returns {Date}
 */
export function getDateFromWeekDayTime(week, dayName, timeStr, year) {
    const date = getDateFromWeekDay(week, dayName, timeStr, year);
    if (year && date.getFullYear() !== year) {
        date.setFullYear(year);
    }
    return date;
}

// ===================================
// Formatage
// ===================================

/**
 * Format a date string to French locale (DD/MM/YYYY).
 * @param {string} dateString - ISO date string
 * @returns {string}
 */
export function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

/**
 * Format decimal hours to "Xh YY" display string.
 * @param {number} hours - e.g. 3.5
 * @returns {string} e.g. "3h30"
 */
export function formatHours(hours) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}h${m > 0 ? m.toString().padStart(2, '0') : ''}`;
}

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
    if (text == null) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

// ===================================
// Métier léger
// ===================================

/**
 * Generate a deterministic slot ID.
 * @param {string} operationId
 * @param {Array} existingSlots - Already existing slots (for counting)
 * @returns {string} e.g. "CC26-0019_cisaillage_slot_1"
 */
export function generateSlotId(operationId, existingSlots) {
    const index = (existingSlots ? existingSlots.length : 0) + 1;
    return `${operationId}_slot_${index}`;
}

/**
 * Get urgency level for a delivery date.
 * @param {string} dateLivraison - ISO date string
 * @param {Date} [now=new Date()] - Reference date
 * @returns {'urgente'|'attention'|'ok'}
 */
export function getUrgencyLevel(dateLivraison, now = new Date()) {
    const livraison = new Date(dateLivraison);
    const diff = Math.ceil((livraison - now) / (1000 * 60 * 60 * 24));

    if (diff <= 5) return 'urgente';
    if (diff <= 10) return 'attention';
    return 'ok';
}

// ===================================
// Toast Notification System
// ===================================

export const Toast = {
    success(message) {
        this.show(message, 'success', '\u2713');
    },

    error(message) {
        this.show(message, 'error', '\u2717');
    },

    warning(message) {
        this.show(message, 'warning', '\u26a0');
    },

    info(message) {
        this.show(message, 'info', '\u2139');
    },

    show(message, type, icon) {
        // Supprimer les toasts existants
        document.querySelectorAll('.toast').forEach(t => t.remove());

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${icon}</span>
            <span class="toast-message">${message}</span>
        `;

        document.body.appendChild(toast);

        // Auto-remove après 3 secondes
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
};

// Expose globally for HTML onclick handlers and non-module scripts
window.Toast = Toast;
