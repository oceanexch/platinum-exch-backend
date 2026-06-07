const { generateMonthlyFinalBills } = require('../services/FinalBillService');
const moment = require('moment');

/**
 * Automates the generation of market-wise monthly final bills.
 * This should run on the 1st of every month to lock the previous month's balances.
 */
exports.generateMonthlyBillsJob = async () => {
    console.log('--------------------------------------------------');
    console.log(`[Monthly Bill Cron] Started at: ${new Date().toISOString()}`);

    try {
        // 1. Get the previous month key (e.g., if today is 2026-05-01, we want "2026-04")
        const prevMonth = moment().subtract(1, 'month');
        const year = prevMonth.year();
        const month = prevMonth.month() + 1; // moment months are 0-indexed

        const monthKey = `${year}-${String(month).padStart(2, '0')}`;
        console.log(`[Monthly Bill Cron] Targets month: ${monthKey}`);

        // 2. Trigger market-wise generation
        await generateMonthlyFinalBills(year, month);

        console.log(`[Monthly Bill Cron] Successfully generated bills for ${monthKey}`);
    } catch (error) {
        console.error(`[Monthly Bill Cron] Fatal error:`, error);
    }

    console.log('--------------------------------------------------');
};
