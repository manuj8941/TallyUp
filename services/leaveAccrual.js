const moment = require( 'moment-timezone' );
const { getMoment } = require( '../db/timezone' );
const { db } = require( '../db/database' );
const { getLeaveBalance, updateLeaveBalance } = require( '../db/users' );

/**
 * Accrue leaves for an employee (runs on startup and monthly cron)
 */
async function accrueLeavesForUserOnStartup ( employee )
{
    return new Promise( ( resolve, reject ) =>
    {
        const now = getMoment();
        const joinDate = moment( employee.join_date, 'YYYY-MM-DD' );
        let lastAccrualMonth = employee.leave_balance_last_updated ? moment( employee.leave_balance_last_updated, 'YYYY-MM' ) : joinDate.clone().startOf( 'month' );
        let currentBalance = parseFloat( employee.leave_balance ) || 0;

        let monthsToAccrue = 0;
        let tempMonth = lastAccrualMonth.clone();

        // Accrue for months since join_date or last_accrual_month up to the current month
        while ( tempMonth.isBefore( now, 'month' ) || tempMonth.isSame( now, 'month' ) )
        {
            // Ensure we don't double count the current month if already accrued
            if ( tempMonth.isSame( now, 'month' ) && employee.leave_balance_last_updated && moment( employee.leave_balance_last_updated, 'YYYY-MM' ).isSame( now, 'month' ) )
            {
                break; // Already accrued for the current month
            }
            // Accrue only if the month is after or same as join_date
            if ( tempMonth.isSameOrAfter( joinDate, 'month' ) )
            {
                monthsToAccrue++;
            }
            tempMonth.add( 1, 'month' );
        }

        if ( monthsToAccrue > 0 )
        {
            currentBalance += monthsToAccrue * 2;
            const newLastAccrualMonth = now.format( 'YYYY-MM' );
            updateLeaveBalance( employee.name, currentBalance, newLastAccrualMonth )
                .then( () =>
                {
                    console.log( `Accrued ${ monthsToAccrue * 2 } leaves for ${ employee.name }. New balance: ${ currentBalance }` );
                    resolve( currentBalance );
                } )
                .catch( ( updateErr ) => reject( updateErr ) );
        }
        else
        {
            resolve( currentBalance );
        }
    } );
}

/**
 * Get leave balance for user
 */
async function calculateAndUpdateLeaveBalance ( username )
{
    return getLeaveBalance( username );
}

/**
 * Run leave accrual for all employees
 */
async function accrueAllEmployees ()
{
    try
    {
        const employees = await new Promise( ( resolve, reject ) =>
        {
            db.all( 'SELECT name, join_date, leave_balance, leave_balance_last_updated FROM users WHERE role != ?', [ 'owner' ], ( err, rows ) =>
            {
                if ( err ) return reject( err );
                resolve( rows || [] );
            } );
        } );

        for ( const emp of employees )
        {
            await accrueLeavesForUserOnStartup( emp );
        }
    }
    catch ( err )
    {
        console.error( 'Error in scheduled leave accrual:', err );
    }
}

/**
 * Start periodic monthly leave accrual checker (runs every hour to check if new month started)
 */
function startMonthlyLeaveAccrualCron ()
{
    // Check every hour (3600000 ms)
    setInterval( () =>
    {
        const now = getMoment();
        // If it's the 1st day of the month
        if ( now.date() === 1 )
        {
            console.log( '📅 1st of the month detected. Running automated monthly leave accrual...' );
            accrueAllEmployees();
        }
    }, 60 * 60 * 1000 );
}

module.exports = {
    accrueLeavesForUserOnStartup,
    calculateAndUpdateLeaveBalance,
    accrueAllEmployees,
    startMonthlyLeaveAccrualCron
};
