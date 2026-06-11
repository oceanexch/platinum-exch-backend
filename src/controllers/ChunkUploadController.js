const path = require('path');
const fs = require('fs');
const { createAppVersion } = require('../services/AppVersionService');
const { getLoginUserId } = require('../utils/contextHelpers');

// Store upload sessions in memory (use Redis in production)
const uploadSessions = new Map();

/**
 * Handle chunk upload from frontend
 * POST /api/app-version/upload
 * 
 * Expects FormData with:
 * - apkFile: File (the chunk data)
 * - chunkIndex: number
 * - totalChunks: number
 * - uploadId: string
 * - version: string
 * - platform: string (optional)
 * - releaseNotes: string (optional)
 * - isMandatory: boolean (optional)
 * - buildNumber: number (optional)
 * - fileName: string
 */
exports.uploadChunk = async (req, res) => {
  try {
    const { chunkIndex, totalChunks, uploadId, version, platform, releaseNotes, isMandatory, buildNumber, fileName } = req.body;
    
    // console.log('Upload chunk request:', { chunkIndex, totalChunks, uploadId, version, fileName });
    
    // Validate required fields
    if (!req.file) {
      return res.status(400).json({
        status: false,
        message: 'Chunk file is required'
      });
    }
    
    if (chunkIndex === undefined || !totalChunks || !version || !fileName || !uploadId) {
      // Clean up uploaded chunk
      if (req.file && req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        status: false,
        message: 'chunkIndex, totalChunks, version, fileName, and uploadId are required'
      });
    }
    
    const chunkIdx = parseInt(chunkIndex);
    const totalChunksNum = parseInt(totalChunks);
    const sessionId = uploadId;
    
    // Rename the temp file to proper chunk name immediately
    const chunksDir = path.join(__dirname, '..', '..', 'uploads', 'chunks');
    const properChunkName = `${sessionId}-chunk-${chunkIdx}`;
    const properChunkPath = path.join(chunksDir, properChunkName);
    
    // Rename temp file to proper name
    fs.renameSync(req.file.path, properChunkPath);
    // console.log(`Renamed ${req.file.filename} to ${properChunkName}`);
    
    // Get or create session
    let session = uploadSessions.get(sessionId);
    if (!session) {
      // Validate version format
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        fs.unlinkSync(properChunkPath);
        return res.status(400).json({
          status: false,
          message: 'Invalid version format. Use semantic versioning (e.g., 1.0.0)'
        });
      }
      
      // Create new session
      session = {
        fileName,
        totalChunks: totalChunksNum,
        version,
        platform: platform || 'both',
        releaseNotes: releaseNotes || '',
        isMandatory: isMandatory === 'true' || isMandatory === true || false,
        buildNumber: buildNumber ? parseInt(buildNumber) : null,
        uploadedChunks: [],
        createdAt: Date.now(),
        userId: getLoginUserId(req),
        user: req.user
      };
      uploadSessions.set(sessionId, session);
      // console.log('Created new session:', sessionId);
    }
    
    // Check if chunk already uploaded
    if (session.uploadedChunks.includes(chunkIdx)) {
      // console.log(`Chunk ${chunkIdx} already recorded, but file exists - keeping it`);
      // Don't delete - file is already properly named
    } else {
      // Add to uploaded chunks
      session.uploadedChunks.push(chunkIdx);
      session.uploadedChunks.sort((a, b) => a - b);
    }
    
    // console.log(`Chunk ${chunkIdx} uploaded. Progress: ${session.uploadedChunks.length}/${session.totalChunks}`);
    
    // Check if all chunks uploaded by checking files on disk
    const existingChunks = [];
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(chunksDir, `${sessionId}-chunk-${i}`);
      if (fs.existsSync(chunkPath)) {
        existingChunks.push(i);
      }
    }
    
    const isComplete = existingChunks.length === session.totalChunks;
    // console.log(`Chunks on disk: ${existingChunks.length}/${session.totalChunks}`);
    
    // If complete, merge chunks
    if (isComplete) {
      // console.log('All chunks present on disk. Starting merge...');
      try {
        // Update session with all chunks
        session.uploadedChunks = existingChunks;
        
        const result = await mergeChunks(sessionId, session, req);
        
        // Clean up session
        uploadSessions.delete(sessionId);
        // console.log('Upload completed successfully');
        
        return res.status(201).json({
          status: true,
          message: 'Upload completed successfully',
          data: result
        });
      } catch (error) {
        console.error('Merge chunks error:', error);
        // Clean up chunks on error
        cleanupChunks(sessionId, session.totalChunks);
        uploadSessions.delete(sessionId);
        
        return res.status(500).json({
          status: false,
          message: error.message || 'Failed to merge chunks'
        });
      }
    }
    
    // Return progress
    res.status(200).json({
      status: true,
      message: 'Chunk uploaded successfully',
      data: {
        uploadId: sessionId,
        chunkIndex: chunkIdx,
        uploadedChunks: existingChunks.length,
        totalChunks: session.totalChunks,
        isComplete: false,
        progress: ((existingChunks.length / session.totalChunks) * 100).toFixed(2)
      }
    });
  } catch (error) {
    console.error('Upload chunk error:', error);
    
    // Clean up uploaded chunk on error
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.error('Error deleting chunk:', unlinkError);
      }
    }
    
    res.status(500).json({
      status: false,
      message: 'Failed to upload chunk'
    });
  }
};

/**
 * Merge all chunks into final APK file
 */
async function mergeChunks(uploadId, session, req) {
  const chunksDir = path.join(__dirname, '..', '..', 'uploads', 'chunks');
  const apkDir = path.join(__dirname, '..', '..', 'uploads', 'apk');
  
  // console.log('=== Starting Merge Process ===');
  // console.log('Upload ID:', uploadId);
  // console.log('Total chunks:', session.totalChunks);
  // console.log('Chunks directory:', chunksDir);
  // console.log('APK directory:', apkDir);
  
  // Ensure apk directory exists
  if (!fs.existsSync(apkDir)) {
    // console.log('Creating APK directory...');
    fs.mkdirSync(apkDir, { recursive: true });
  }
  
  // Verify all chunks exist before merging
  // console.log('Verifying chunks...');
  const missingChunks = [];
  for (let i = 0; i < session.totalChunks; i++) {
    const chunkPath = path.join(chunksDir, `${uploadId}-chunk-${i}`);
    if (!fs.existsSync(chunkPath)) {
      missingChunks.push(i);
      console.error(`Chunk ${i} is missing at path: ${chunkPath}`);
    } else {
      const stats = fs.statSync(chunkPath);
      // console.log(`Chunk ${i} exists, size: ${stats.size} bytes`);
    }
  }
  
  if (missingChunks.length > 0) {
    throw new Error(`Missing chunks: ${missingChunks.join(', ')}`);
  }
  
  // Generate final filename
  const sanitizedVersion = session.version.replace(/\./g, '_');
  const finalFileName = `app-v${sanitizedVersion}-${Date.now()}.apk`;
  const finalFilePath = path.join(apkDir, finalFileName);
  
  // console.log('Merging chunks into:', finalFileName);
  // console.log('Final file path:', finalFilePath);
  
  // Create write stream for final file
  const writeStream = fs.createWriteStream(finalFilePath);
  
  // Track merge progress
  let totalBytesWritten = 0;
  
  // Merge chunks in order
  for (let i = 0; i < session.totalChunks; i++) {
    const chunkPath = path.join(chunksDir, `${uploadId}-chunk-${i}`);
    
    try {
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
      totalBytesWritten += chunkData.length;
      // console.log(`Merged chunk ${i}, bytes: ${chunkData.length}, total: ${totalBytesWritten}`);
      
      // Delete chunk after merging
      fs.unlinkSync(chunkPath);
      // console.log(`Deleted chunk ${i}`);
    } catch (error) {
      console.error(`Error processing chunk ${i}:`, error);
      writeStream.close();
      if (fs.existsSync(finalFilePath)) {
        fs.unlinkSync(finalFilePath);
      }
      throw new Error(`Failed to process chunk ${i}: ${error.message}`);
    }
  }
  
  writeStream.end();
  
  // Wait for write stream to finish
  await new Promise((resolve, reject) => {
    writeStream.on('finish', () => {
      // console.log('Write stream finished');
      resolve();
    });
    writeStream.on('error', (error) => {
      console.error('Write stream error:', error);
      reject(error);
    });
  });
  
  // Verify final file exists and has correct size
  if (!fs.existsSync(finalFilePath)) {
    throw new Error('Final file was not created');
  }
  
  const stats = fs.statSync(finalFilePath);
  const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2) + ' MB';
  
  // console.log('Merge complete!');
  // console.log('Final file size:', fileSizeInMB);
  // console.log('Total bytes written:', totalBytesWritten);
  // console.log('File size on disk:', stats.size);
  
  if (stats.size !== totalBytesWritten) {
    console.warn('Warning: File size mismatch!');
  }
  
  // Create version entry in database
  const ip = req.ip || req.connection.remoteAddress;
  
  const versionData = {
    version: session.version,
    fileName: finalFileName,
    platform: session.platform,
    isMandatory: session.isMandatory,
    releaseNotes: session.releaseNotes,
    minSupportedVersion: session.minSupportedVersion || null,
    fileSize: fileSizeInMB,
    buildNumber: session.buildNumber,
    createdBy: session.userId,
    ip: ip,
    parentIds: session.user.parentIds || []
  };
  
  // console.log('Creating database entry...');
  const newVersion = await createAppVersion(versionData);
  // console.log('Database entry created:', newVersion._id);
  
  // Generate download link
  const downloadLink = `${req.protocol}://${req.get('host')}/platinum-back/api/app-version/download/${newVersion._id}`;
  
  // console.log('=== Merge Process Complete ===');
  
  return {
    ...newVersion.toObject(),
    downloadLink,
    isComplete: true
  };
}

/**
 * Clean up chunks for a session
 */
function cleanupChunks(uploadId, totalChunks) {
  const chunksDir = path.join(__dirname, '..', '..', 'uploads', 'chunks');
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(chunksDir, `${uploadId}-chunk-${i}`);
    if (fs.existsSync(chunkPath)) {
      try {
        fs.unlinkSync(chunkPath);
      } catch (error) {
        console.error(`Error deleting chunk ${i}:`, error);
      }
    }
  }
}

// Clean up old sessions (run periodically)
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const [uploadId, session] of uploadSessions.entries()) {
    if (now - session.createdAt > maxAge) {
      cleanupChunks(uploadId, session.totalChunks);
      uploadSessions.delete(uploadId);
      // console.log(`Cleaned up expired upload session: ${uploadId}`);
    }
  }
}, 60 * 60 * 1000); // Run every hour
