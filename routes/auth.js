const express = require( 'express' );
const router = express.Router();
const moment = require( 'moment-timezone' );
const { db } = require( '../db/database' );
const { getSetting } = require( '../db/settings' );
const { getTimezone } = require( '../db/timezone' );
const { saveFile, deleteFile } = require( '../db/storage' );
const { requireLogin } = require( '../middleware/auth' );
const {
    getUserByName,
    verifyPassword,
    updateSessionId,
    capitalizeUsername,
    updatePassword
} = require( '../db/users' );
const { isRequestMobile, getEffectiveDate } = require( '../utils/dateHelper' );

// Login POST
router.post( '/login', async ( req, res ) =>
{
    try
    {
        const { name, password } = req.body;
        const user = await getUserByName( name );

        if ( user )
        {
            if ( user.is_active === 0 )
            {
                req.session.loginError = 'This account has been deactivated. Please contact your administrator.';
                return res.redirect( '/?error=deactivated' );
            }

            // If desktop access is disabled, prevent non-owner logins from desktop devices
            getSetting( 'desktop_enabled' ).then( ( value ) =>
            {
                const enabled = value || '1';
                const isMobileReq = isRequestMobile( req );
                if ( enabled === '0' && !isMobileReq && user.role !== 'owner' )
                {
                    req.session.loginError = null;
                    return res.redirect( '/?desktop_blocked=1' );
                }

                if ( verifyPassword( password, user.password ) )
                {
                    const prevSid = user.current_session_id || '';
                    const newSid = req.sessionID;

                    const finalizeLogin = () =>
                    {
                        req.session.user = { name: user.name, role: user.role, displayName: capitalizeUsername( user.name ) };
                        req.session.createdAt = Date.now();
                        if ( req.session.loginError ) delete req.session.loginError;
                        return res.redirect( '/dashboard' );
                    };

                    if ( prevSid && prevSid !== newSid )
                    {
                        try
                        {
                            if ( req.sessionStore && typeof req.sessionStore.destroy === 'function' )
                            {
                                req.sessionStore.destroy( prevSid, async () =>
                                {
                                    try
                                    {
                                        await updateSessionId( user.name, newSid );
                                    } catch ( upErr )
                                    {
                                        console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                                    }
                                    return finalizeLogin();
                                } );
                            }
                            else
                            {
                                ( async () =>
                                {
                                    try
                                    {
                                        await updateSessionId( user.name, newSid );
                                    } catch ( upErr )
                                    {
                                        console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                                    }
                                    return finalizeLogin();
                                } )();
                            }
                        }
                        catch ( e )
                        {
                            console.error( 'Error destroying previous session', e );
                            ( async () =>
                            {
                                try
                                {
                                    await updateSessionId( user.name, newSid );
                                } catch ( upErr )
                                {
                                    console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                                }
                                return finalizeLogin();
                            } )();
                        }
                    }
                    else
                    {
                        ( async () =>
                        {
                            try
                            {
                                await updateSessionId( user.name, newSid );
                            } catch ( upErr )
                            {
                                console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                            }
                            return finalizeLogin();
                        } )();
                    }
                }
                else
                {
                    req.session.loginError = 'Hmm, that doesn\'t look right. Check your username and password and try again.';
                    return res.redirect( '/' );
                }
            } ).catch( ( setErr ) =>
            {
                console.error( 'Error reading settings during login:', setErr && setErr.message );
                return res.redirect( '/' );
            } );
        }
        else
        {
            req.session.loginError = 'Hmm, that doesn\'t look right. Check your username and password and try again.';
            return res.redirect( '/' );
        }
    }
    catch ( err )
    {
        console.error( err.message );
        req.session.loginError = 'Oops! Something went wrong. Please try signing in again.';
        return res.redirect( '/' );
    }
} );

// Login error flash (read-and-clear)
router.get( '/login/error', ( req, res ) =>
{
    const errMsg = req.session.loginError || null;
    if ( req.session.loginError ) delete req.session.loginError;
    res.json( { error: errMsg } );
} );

// Logout
router.get( '/logout', async ( req, res ) =>
{
    if ( req.session && req.session.user )
    {
        const username = req.session.user.name;
        try
        {
            await updateSessionId( username, '' );
        }
        catch ( upErr )
        {
            console.error( 'Failed to clear current_session_id on logout', upErr && upErr.message );
        }
    }
    req.session.destroy( () =>
    {
        res.redirect( '/' );
    } );
} );

// Current User Details
router.get( '/user/me', requireLogin, async ( req, res ) =>
{
    try
    {
        const user = await getUserByName( req.session.user.name );
        if ( !user ) return res.status( 404 ).json( { error: 'User not found' } );

        const effectiveDate = getEffectiveDate( req );
        const timezone = getTimezone();
        const now = moment().tz( timezone );
        const effectiveDateTime = moment.tz( `${ effectiveDate } ${ now.format( 'HH:mm:ss' ) }`, 'YYYY-MM-DD HH:mm:ss', timezone );

        res.json( {
            name: user.name,
            role: user.role,
            displayName: req.session.user.displayName || capitalizeUsername( user.name ),
            join_date: user.join_date,
            profile_picture: user.profile_picture || null,
            effectiveDate: effectiveDate,
            currentDateTime: effectiveDateTime.format()
        } );
    }
    catch ( err )
    {
        console.error( 'Error in /user/me:', err );
        res.status( 500 ).json( { error: 'Error fetching user profile' } );
    }
} );

// Change own password
router.post( '/user/change-password', requireLogin, async ( req, res ) =>
{
    const { old_password, new_password } = req.body;
    const username = req.session.user.name;

    if ( !new_password || !new_password.trim() )
    {
        return res.status( 400 ).json( { success: false, message: 'Please enter a new password.' } );
    }

    try
    {
        const user = await getUserByName( username );
        if ( !user ) return res.status( 404 ).json( { success: false, message: 'User not found.' } );

        if ( !old_password )
        {
            return res.status( 400 ).json( { success: false, message: 'Please enter your current password to confirm.' } );
        }

        if ( !verifyPassword( ( old_password || '' ).toString(), user.password ) )
        {
            return res.status( 400 ).json( { success: false, message: 'Hmm, that current password doesn\'t match. Please try again.' } );
        }

        await updatePassword( username, new_password.trim() );
        if ( req.session.user ) req.session.user = { name: username, role: req.session.user.role };
        return res.json( { success: true, message: 'Password updated! All set. ✅' } );
    }
    catch ( e )
    {
        return res.status( 500 ).json( { success: false, message: e.message || 'Error updating password.' } );
    }
} );

// Upload profile picture
router.post( '/user/profile-picture', requireLogin, async ( req, res ) =>
{
    const { picture } = req.body;

    if ( !picture || !picture.startsWith( 'data:image' ) )
    {
        return res.status( 400 ).json( { success: false, message: 'Please provide a valid image.' } );
    }

    try
    {
        const matches = picture.match( /^data:image\/(\w+);base64,(.+)$/ );
        if ( !matches )
        {
            return res.status( 400 ).json( { success: false, message: 'Invalid image format.' } );
        }

        const base64Data = matches[ 2 ];
        const buffer = Buffer.from( base64Data, 'base64' );

        const sizeKB = buffer.length / 1024;
        if ( sizeKB > 100 )
        {
            return res.status( 400 ).json( {
                success: false,
                message: `Image is too large (${ Math.round( sizeKB ) }KB). Please ensure it's compressed properly.`
            } );
        }

        const username = req.session.user.name;
        const user = await getUserByName( username );
        if ( !user ) return res.status( 404 ).json( { success: false, message: 'User not found.' } );

        if ( user.profile_picture )
        {
            try
            {
                const oldKey = user.profile_picture.replace( '/r2-proxy/', '' );
                await deleteFile( oldKey );
            }
            catch ( err )
            {
                console.error( 'Error deleting old profile picture:', err.message );
            }
        }

        const filename = `${ username }.jpg`;
        const filePath = `profile-pictures/${ filename }`;
        const publicUrl = await saveFile( buffer, filePath, 'image/jpeg' );

        await db.run( 'UPDATE users SET profile_picture = ? WHERE name = ?', [ publicUrl, username ] );

        res.json( { success: true, message: 'Profile picture updated! 📸', picture_url: publicUrl } );
    }
    catch ( err )
    {
        console.error( 'Error uploading profile picture:', err );
        res.status( 500 ).json( { success: false, message: 'Error uploading picture. Please try again.' } );
    }
} );

// Delete profile picture
router.delete( '/user/profile-picture', requireLogin, async ( req, res ) =>
{
    try
    {
        const username = req.session.user.name;
        const user = await getUserByName( username );
        if ( !user ) return res.status( 404 ).json( { success: false, message: 'User not found.' } );

        if ( !user.profile_picture )
        {
            return res.json( { success: true, message: 'No profile picture to remove.' } );
        }

        try
        {
            const key = user.profile_picture.replace( '/r2-proxy/', '' );
            await deleteFile( key );
        }
        catch ( err )
        {
            console.error( 'Error deleting profile picture from R2:', err.message );
        }

        await db.run( 'UPDATE users SET profile_picture = NULL WHERE name = ?', [ username ] );

        res.json( { success: true, message: 'Profile picture removed.' } );
    }
    catch ( err )
    {
        console.error( 'Error removing profile picture:', err );
        res.status( 500 ).json( { success: false, message: 'Error removing picture. Please try again.' } );
    }
} );

module.exports = router;
