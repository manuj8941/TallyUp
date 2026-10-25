const express = require( 'express' );
const router = express.Router();
const path = require( 'path' );
const { requireLogin, requireAdmin, requireOwner } = require( '../middleware/auth' );
const { getSettings } = require( '../db/settings' );

const viewsDir = path.join( __dirname, '..', 'views' );

// Home / Root
router.get( '/', ( req, res ) =>
{
    if ( req.session && req.session.user )
    {
        res.redirect( '/dashboard' );
    }
    else
    {
        res.sendFile( path.join( viewsDir, 'login.html' ) );
    }
} );

// Login page alias
router.get( '/login', ( req, res ) =>
{
    if ( req.session && req.session.user )
    {
        res.redirect( '/dashboard' );
    }
    else
    {
        res.sendFile( path.join( viewsDir, 'login.html' ) );
    }
} );

// Profile page
router.get( '/profile', requireLogin, ( req, res ) =>
{
    res.sendFile( path.join( viewsDir, 'profile.html' ) );
} );

// Dashboard page
router.get( '/dashboard', requireLogin, ( req, res ) =>
{
    res.sendFile( path.join( viewsDir, 'dashboard.html' ) );
} );

// App Settings (Owner only)
router.get( '/appsettings', requireOwner, ( req, res ) =>
{
    res.sendFile( path.join( viewsDir, 'appsettings.html' ) );
} );

// Visual Calendar page
router.get( '/visual', requireLogin, ( req, res ) =>
{
    res.sendFile( path.join( viewsDir, 'visual.html' ) );
} );

// Team Management page (Admin & Manager)
router.get( '/team', requireAdmin, ( req, res ) =>
{
    res.sendFile( path.join( viewsDir, 'team.html' ) );
} );

// Enterprise SaaS Preview page
router.get( '/demo', ( req, res ) =>
{
    res.sendFile( path.join( viewsDir, 'enterprise-demo.html' ) );
} );

// Branding endpoint
router.get( '/branding', async ( req, res ) =>
{
    try
    {
        const settings = await getSettings( [ 'company_logo', 'brand_color', 'company_name', 'timezone' ] );

        res.json( {
            logo: settings.company_logo || '',
            brandColor: settings.brand_color || '#0ea5a4',
            companyName: settings.company_name || 'Attendance System',
            timezone: settings.timezone || 'Asia/Kolkata'
        } );
    }
    catch ( err )
    {
        res.status( 500 ).json( { success: false } );
    }
} );

// PWA Manifest
router.get( '/manifest.json', async ( req, res ) =>
{
    try
    {
        const settings = await getSettings( [ 'brand_color', 'company_name' ] );
        const themeColor = settings.brand_color || '#0ea5a4';
        const appName = settings.company_name || 'Attendance Tracker';

        const manifest = {
            name: appName,
            short_name: appName.length > 12 ? appName.substring( 0, 12 ) : appName,
            description: "Employee attendance tracking system with leave management",
            start_url: "/",
            display: "standalone",
            display_override: [ "window-controls-overlay", "standalone" ],
            background_color: "#ffffff",
            theme_color: themeColor,
            orientation: "portrait-primary",
            scope: "/",
            launch_handler: {
                client_mode: "navigate-existing"
            },
            prefer_related_applications: false,
            icons: [
                {
                    src: "/icons/icon-192.png",
                    sizes: "192x192",
                    type: "image/png",
                    purpose: "any"
                },
                {
                    src: "/icons/icon-512.png",
                    sizes: "512x512",
                    type: "image/png",
                    purpose: "any"
                },
                {
                    src: "/icons/icon-512-maskable.png",
                    sizes: "512x512",
                    type: "image/png",
                    purpose: "maskable"
                }
            ],
            categories: [ "productivity", "business" ],
            screenshots: []
        };

        res.setHeader( 'Content-Type', 'application/manifest+json' );
        res.json( manifest );
    }
    catch ( err )
    {
        console.error( 'Error generating manifest:', err );
        res.sendFile( path.join( __dirname, '..', 'public', 'manifest.json' ) );
    }
} );

module.exports = router;
