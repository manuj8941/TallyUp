require( 'dotenv' ).config( { quiet: true } );
const express = require( 'express' );
const path = require( 'path' );
const session = require( 'express-session' );
const fs = require( 'fs' );

// Database & Services
const { initializeDatabase } = require( './db/database' );
const { useTurso } = require( './db/connection' );
const { initTimezone } = require( './db/settings' );
const { useCloudStorage } = require( './db/storage' );
const { users } = require( './db/seed' );
const { accrueLeavesForUserOnStartup, startMonthlyLeaveAccrualCron } = require( './services/leaveAccrual' );

// Middlewares
const { enforceDeviceAccess } = require( './middleware/device' );
const { requireLogin } = require( './middleware/auth' );

// Routers
const viewsRoutes = require( './routes/views' );
const authRoutes = require( './routes/auth' );
const attendanceRoutes = require( './routes/attendance' );
const leavesRoutes = require( './routes/leaves' );
const visualRoutes = require( './routes/visual' );
const adminRoutes = require( './routes/admin' );
const proxyRoutes = require( './routes/proxy' );

const app = express();

// Ensure local directories exist (for local storage mode)
const selfiesDir = path.join( __dirname, 'selfies' );
const logosDir = path.join( __dirname, 'logos' );
if ( !fs.existsSync( selfiesDir ) ) fs.mkdirSync( selfiesDir, { recursive: true } );
if ( !fs.existsSync( logosDir ) ) fs.mkdirSync( logosDir, { recursive: true } );
users.forEach( user =>
{
    const userSelfieDir = path.join( selfiesDir, user.name );
    if ( !fs.existsSync( userSelfieDir ) ) fs.mkdirSync( userSelfieDir, { recursive: true } );
} );

// Session store configuration with graceful fallback for all Node environments
let sessionStore;
try
{
    const SqliteStore = require( 'better-sqlite3-session-store' )( session );
    const Database = require( 'better-sqlite3' );
    const dbPath = useTurso
        ? path.join( require( 'os' ).tmpdir(), 'sessions.db' )
        : path.join( __dirname, 'sessions.db' );

    sessionStore = new SqliteStore( {
        client: new Database( dbPath ),
        expired: {
            clear: true,
            intervalMs: 900000 // 15 minutes
        }
    } );
}
catch ( e )
{
    // Fallback to standard memory store if native sqlite binary is unavailable
    sessionStore = new session.MemoryStore();
}

app.use( session( {
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'fallback_dev_secret_change_in_production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: false,
        sameSite: 'lax'
    },
    name: 'attendance.sid'
} ) );

// Optimized Body parser limits (5MB is ample for compressed photos & canvas data)
app.use( express.urlencoded( { extended: true, limit: '5mb' } ) );
app.use( express.json( { limit: '5mb' } ) );

// Static file serving
if ( !useCloudStorage )
{
    app.use( '/selfies', express.static( 'selfies' ) );
    app.use( '/logos', express.static( 'logos' ) );
}
app.use( express.static( 'public' ) );

// Device access check middleware
app.use( enforceDeviceAccess );

// Initialize Database & Services
( async () =>
{
    try
    {
        await initializeDatabase( app, accrueLeavesForUserOnStartup );
        initTimezone();
        startMonthlyLeaveAccrualCron();
    }
    catch ( err )
    {
        console.error( 'Database initialization error:', err );
    }
} )();

// Mount Modular Routes
app.use( '/', viewsRoutes );
app.use( '/', authRoutes );
app.use( '/', proxyRoutes );
app.use( '/', attendanceRoutes );
app.use( '/', leavesRoutes );
app.use( '/', visualRoutes );
app.use( '/', adminRoutes );

// Normalize invalid dashboard subpaths
app.use( '/dashboard', requireLogin, ( req, res, next ) =>
{
    if ( req.method === 'GET' && req.path && req.path !== '/' && req.path !== '' )
    {
        return res.redirect( '/dashboard' );
    }
    next();
} );

// 404 Handler
app.use( ( req, res ) =>
{
    res.status( 404 ).sendFile( path.join( __dirname, 'views', '404.html' ) );
} );

// 500 Error Handler
app.use( ( err, req, res, next ) =>
{
    console.error( 'Server error:', err );
    if ( req.accepts( 'html' ) )
    {
        res.status( 500 ).sendFile( path.join( __dirname, 'views', '500.html' ) );
    }
    else
    {
        res.status( 500 ).json( { error: 'Internal Server Error' } );
    }
} );

module.exports = app;

// Server Startup
if ( require.main === module )
{
    const PORT = process.env.PORT || 3000;
    const os = require( 'os' );

    const pemFiles = fs.readdirSync( __dirname ).filter( f => f.endsWith( '.pem' ) );
    const keyFile = pemFiles.find( f => f.includes( '-key' ) );
    const certFile = pemFiles.find( f => !f.includes( '-key' ) && f.endsWith( '.pem' ) );

    const isProduction = process.env.NODE_ENV === 'production';
    const hasCerts = keyFile && certFile;

    if ( !isProduction && hasCerts )
    {
        const https = require( 'https' );
        const keyPath = path.join( __dirname, keyFile );
        const certPath = path.join( __dirname, certFile );

        try
        {
            const key = fs.readFileSync( keyPath );
            const cert = fs.readFileSync( certPath );
            https.createServer( { key, cert }, app ).listen( PORT, '0.0.0.0', () =>
            {
                const localIP = getLocalIP();
                console.log( `✅ HTTPS server running on port ${ PORT }` );
                console.log( `📱 Access from mobile: https://${ localIP }:${ PORT }` );
                console.log( `💻 Access locally: https://localhost:${ PORT }` );
                console.log( `🔒 Using certificates: ${ keyFile }, ${ certFile }` );
            } );
        }
        catch ( err )
        {
            console.error( '❌ Failed to start HTTPS server:', err.message );
            console.log( '⚠️  Falling back to HTTP...' );
            startHttpServer();
        }
    }
    else
    {
        if ( isProduction )
        {
            console.log( '🌐 Production mode: Starting HTTP server (platform handles HTTPS)' );
        }
        else
        {
            console.log( '⚠️  No certificates found. Starting HTTP server.' );
        }
        startHttpServer();
    }

    function startHttpServer ()
    {
        app.listen( PORT, '0.0.0.0', () =>
        {
            const localIP = getLocalIP();
            console.log( `✅ HTTP server running on port ${ PORT }` );
            console.log( `📱 Access from mobile: http://${ localIP }:${ PORT }` );
            console.log( `💻 Access locally: http://localhost:${ PORT }` );
        } );
    }

    function getLocalIP ()
    {
        const networkInterfaces = os.networkInterfaces();
        const allIPs = Object.values( networkInterfaces )
            .flat()
            .filter( iface => iface.family === 'IPv4' && !iface.internal )
            .map( iface => iface.address );

        return allIPs.find( ip => ip.startsWith( '192.168.1.' ) )
            || allIPs.find( ip => ip.startsWith( '192.168.0.' ) )
            || allIPs.find( ip => ip.startsWith( '10.' ) )
            || allIPs[ 0 ]
            || 'localhost';
    }
}