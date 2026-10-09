const { getCurrentSessionId } = require( '../db/users' );

function requireLogin ( req, res, next )
{
    if ( !req.session || !req.session.user )
    {
        return res.redirect( '/' );
    }

    // Verify this session matches the single-session id stored on the users row.
    getCurrentSessionId( req.session.user.name )
        .then( ( stored ) =>
        {
            if ( stored && stored !== req.sessionID )
            {
                // Another session has replaced this one; destroy current session and redirect to login
                return req.session.destroy( () => res.redirect( '/?session_invalidated=1' ) );
            }
            return next();
        } )
        .catch( ( err ) =>
        {
            console.error( 'Error verifying session id for user', req.session.user && req.session.user.name, err && err.message );
            // On DB error, allow the session (fail-open) so users are not locked out due to transient DB issues.
            return next();
        } );
}

function requireAdmin ( req, res, next )
{
    if ( req.session.user && ( req.session.user.role === 'owner' || req.session.user.role === 'manager' ) )
    {
        next();
    }
    else
    {
        return res.redirect( '/?error=access_denied' );
    }
}

function requireOwner ( req, res, next )
{
    if ( req.session.user && req.session.user.role === 'owner' )
    {
        return next();
    }
    return res.redirect( '/?error=access_denied' );
}

module.exports = {
    requireLogin,
    requireAdmin,
    requireOwner
};
