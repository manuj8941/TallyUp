const express = require( 'express' );
const router = express.Router();
const path = require( 'path' );
const fs = require( 'fs' );
const { requireLogin } = require( '../middleware/auth' );
const { useCloudStorage, getFileFromR2 } = require( '../db/storage' );

// Public route for logos (no authentication required - needed for login page branding)
router.get( '/r2-proxy/logos/:filename', async ( req, res ) =>
{
    try
    {
        const { filename } = req.params;
        const filePath = `logos/${ filename }`;

        // Validate file path to prevent directory traversal
        if ( filename.includes( '..' ) )
        {
            return res.status( 400 ).send( 'Invalid file path' );
        }

        if ( useCloudStorage )
        {
            const { body, contentType } = await getFileFromR2( filePath );
            res.setHeader( 'Content-Type', contentType );
            res.setHeader( 'Cache-Control', 'public, max-age=3600' );
            res.send( body );
        }
        else
        {
            const fullPath = path.join( __dirname, '..', filePath );
            if ( !fs.existsSync( fullPath ) )
            {
                return res.status( 404 ).send( 'File not found' );
            }
            res.sendFile( fullPath );
        }
    }
    catch ( error )
    {
        console.error( 'Error serving logo from R2 proxy:', error );
        res.status( 500 ).send( 'Error loading file' );
    }
} );

// Route for 2-segment paths (requires authentication): /r2-proxy/folder/file.png
router.get( '/r2-proxy/:folder/:filename', requireLogin, async ( req, res ) =>
{
    try
    {
        const { folder, filename } = req.params;

        if ( folder === 'logos' )
        {
            return res.redirect( `/r2-proxy/logos/${ filename }` );
        }

        const filePath = `${ folder }/${ filename }`;

        if ( filePath.includes( '..' ) )
        {
            return res.status( 400 ).send( 'Invalid file path' );
        }

        if ( useCloudStorage )
        {
            const { body, contentType } = await getFileFromR2( filePath );
            res.setHeader( 'Content-Type', contentType );
            res.setHeader( 'Cache-Control', 'private, max-age=3600' );
            res.send( body );
        }
        else
        {
            const fullPath = path.join( __dirname, '..', filePath );
            if ( !fs.existsSync( fullPath ) )
            {
                console.error( `File not found at: ${ fullPath }` );
                return res.status( 404 ).send( 'File not found' );
            }
            res.sendFile( fullPath );
        }
    }
    catch ( error )
    {
        console.error( 'Error serving file from R2 proxy (2-segment):', error );
        res.status( 500 ).send( 'Error loading file' );
    }
} );

// Route for 3-segment paths (selfies): /r2-proxy/selfies/user/file.jpg
router.get( '/r2-proxy/:folder/:subfolder/:filename', requireLogin, async ( req, res ) =>
{
    try
    {
        const { folder, subfolder, filename } = req.params;
        const filePath = `${ folder }/${ subfolder }/${ filename }`;

        if ( filePath.includes( '..' ) )
        {
            return res.status( 400 ).send( 'Invalid file path' );
        }

        if ( useCloudStorage )
        {
            const { body, contentType } = await getFileFromR2( filePath );
            res.setHeader( 'Content-Type', contentType );
            res.setHeader( 'Cache-Control', 'private, max-age=3600' );
            res.send( body );
        }
        else
        {
            const fullPath = path.join( __dirname, '..', filePath );
            if ( !fs.existsSync( fullPath ) )
            {
                return res.status( 404 ).send( 'File not found' );
            }
            res.sendFile( fullPath );
        }
    }
    catch ( error )
    {
        console.error( 'Error serving file from R2 proxy:', error );
        res.status( 500 ).send( 'Error loading file' );
    }
} );

module.exports = router;
