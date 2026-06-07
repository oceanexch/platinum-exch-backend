const {
  createAppVersion,
  getAllAppVersions,
  getAppVersionById,
  getLatestVersion,
  updateAppVersion,
  deleteAppVersion,
  checkVersionUpdate
} = require('../services/AppVersionService');
const { getLoginUserId } = require('../utils/contextHelpers');
const path = require('path');
const fs = require('fs');

/**
 * Create a new app version (metadata only - used after chunk upload completes)
 * POST /api/app-version
 */
exports.createVersion = async (req, res) => {
  try {
    const { version, link, platform, isMandatory, releaseNotes, minSupportedVersion, fileSize, buildNumber, fileName } = req.body;
    
    // Validation
    if (!version) {
      return res.status(400).json({
        status: false,
        message: 'Version is required'
      });
    }
    
    // Validate version format
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      return res.status(400).json({
        status: false,
        message: 'Invalid version format. Use semantic versioning (e.g., 1.0.0)'
      });
    }
    
    // Validate platform
    if (platform && !['android', 'ios', 'both'].includes(platform.toLowerCase())) {
      return res.status(400).json({
        status: false,
        message: 'Invalid platform. Must be android, ios, or both'
      });
    }
    
    const userId = getLoginUserId(req);
    const ip = req.ip || req.connection.remoteAddress;
    
    const versionData = {
      version: version.trim(),
      fileName: fileName || `app-v${version.replace(/\./g, '_')}.apk`,
      platform: platform ? platform.toLowerCase() : 'both',
      isMandatory: isMandatory === 'true' || isMandatory === true || false,
      releaseNotes: releaseNotes || '',
      minSupportedVersion: minSupportedVersion || null,
      fileSize: fileSize || null,
      buildNumber: buildNumber ? parseInt(buildNumber) : null,
      createdBy: userId,
      ip: ip,
      parentIds: req.user.parentIds || []
    };
    
    const newVersion = await createAppVersion(versionData);
    
    // Generate download link
    const downloadLink = `${req.protocol}://${req.get('host')}/oceanexch/api/app-version/download/${newVersion._id}`;
    
    res.status(201).json({
      status: true,
      message: 'App version created successfully',
      data: {
        ...newVersion.toObject(),
        downloadLink
      }
    });
  } catch (error) {
    console.error('Create version error:', error);
    
    if (error.message === 'Version already exists') {
      return res.status(409).json({
        status: false,
        message: 'Version already exists'
      });
    }
    
    res.status(500).json({
      status: false,
      message: error.message || 'Failed to create app version'
    });
  }
};

/**
 * Get all app versions
 * GET /api/app-version
 */
exports.getAllVersions = async (req, res) => {
  try {
    const { platform, isActive } = req.query;
    
    const filters = {};
    
    if (platform) {
      filters.platform = platform.toLowerCase();
    }
    
    if (isActive !== undefined) {
      filters.isActive = isActive === 'true';
    }
    
    const versions = await getAllAppVersions(filters);
    
    // Add download links to each version
    const versionsWithLinks = versions.map(version => ({
      ...version.toObject(),
      downloadLink: `${req.protocol}://${req.get('host')}/oceanexch/api/app-version/download/${version._id}`
    }));
    
    res.status(200).json({
      status: true,
      data: versionsWithLinks,
      count: versionsWithLinks.length
    });
  } catch (error) {
    console.error('Get all versions error:', error);
    res.status(500).json({
      status: false,
      message: 'Failed to fetch app versions'
    });
  }
};

/**
 * Get app version by ID
 * GET /api/app-version/:id
 */
exports.getVersionById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const version = await getAppVersionById(id);
    
    // Add download link
    const versionWithLink = {
      ...version.toObject(),
      downloadLink: `${req.protocol}://${req.get('host')}/oceanexch/api/app-version/download/${version._id}`
    };
    
    res.status(200).json({
      status: true,
      data: versionWithLink
    });
  } catch (error) {
    console.error('Get version by ID error:', error);
    
    if (error.message === 'Invalid version ID' || error.message === 'Version not found') {
      return res.status(404).json({
        status: false,
        message: error.message
      });
    }
    
    res.status(500).json({
      status: false,
      message: 'Failed to fetch app version'
    });
  }
};

/**
 * Get latest app version
 * GET /api/app-version/latest
 */
exports.getLatest = async (req, res) => {
  try {
    const { platform } = req.query;
    
    const version = await getLatestVersion(platform);
    
    if (!version) {
      return res.status(404).json({
        status: false,
        message: 'No active version found'
      });
    }
    
    // Add download link
    const versionWithLink = {
      ...version.toObject(),
      downloadLink: `${req.protocol}://${req.get('host')}/oceanexch/api/app-version/download/${version._id}`
    };
    
    res.status(200).json({
      status: true,
      data: versionWithLink
    });
  } catch (error) {
    console.error('Get latest version error:', error);
    res.status(500).json({
      status: false,
      message: 'Failed to fetch latest version'
    });
  }
};

/**
 * Check for version update
 * GET /api/app-version/check-update
 */
exports.checkUpdate = async (req, res) => {
  try {
    const { currentVersion, platform } = req.query;
    
    if (!currentVersion || !platform) {
      return res.status(400).json({
        status: false,
        message: 'currentVersion and platform are required'
      });
    }
    
    // Validate version format
    if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
      return res.status(400).json({
        status: false,
        message: 'Invalid version format. Use semantic versioning (e.g., 1.0.0)'
      });
    }
    
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const updateInfo = await checkVersionUpdate(currentVersion, platform.toLowerCase(), baseUrl);
    
    res.status(200).json({
      status: true,
      data: updateInfo
    });
  } catch (error) {
    console.error('Check update error:', error);
    res.status(500).json({
      status: false,
      message: 'Failed to check for updates'
    });
  }
};

/**
 * Update app version
 * PUT /api/app-version/:id
 */
exports.updateVersion = async (req, res) => {
  try {
    const { id } = req.params;
    const { link, platform, isActive, isMandatory, releaseNotes, minSupportedVersion, fileSize, buildNumber } = req.body;
    
    const userId = getLoginUserId(req);
    const ip = req.ip || req.connection.remoteAddress;
    
    const updateData = {
      updatedBy: userId,
      ip: ip
    };
    
    // Only update fields that are provided
    if (link !== undefined) updateData.link = link.trim();
    if (platform !== undefined) {
      if (!['android', 'ios', 'both'].includes(platform.toLowerCase())) {
        return res.status(400).json({
          status: false,
          message: 'Invalid platform. Must be android, ios, or both'
        });
      }
      updateData.platform = platform.toLowerCase();
    }
    if (isActive !== undefined) updateData.isActive = isActive;
    if (isMandatory !== undefined) updateData.isMandatory = isMandatory;
    if (releaseNotes !== undefined) updateData.releaseNotes = releaseNotes;
    if (minSupportedVersion !== undefined) updateData.minSupportedVersion = minSupportedVersion;
    if (fileSize !== undefined) updateData.fileSize = fileSize;
    if (buildNumber !== undefined) updateData.buildNumber = buildNumber;
    
    const updatedVersion = await updateAppVersion(id, updateData);
    
    res.status(200).json({
      status: true,
      message: 'App version updated successfully',
      data: updatedVersion
    });
  } catch (error) {
    console.error('Update version error:', error);
    
    if (error.message === 'Invalid version ID' || error.message === 'Version not found') {
      return res.status(404).json({
        status: false,
        message: error.message
      });
    }
    
    if (error.message === 'Version already exists') {
      return res.status(409).json({
        status: false,
        message: 'Version already exists'
      });
    }
    
    res.status(500).json({
      status: false,
      message: error.message || 'Failed to update app version'
    });
  }
};

/**
 * Delete app version
 * DELETE /api/app-version/:id
 */
exports.deleteVersion = async (req, res) => {
  try {
    const { id } = req.params;
    
    const deletedVersion = await deleteAppVersion(id);
    
    // Delete the APK file from disk
    const apkPath = path.join(__dirname, '..', '..', 'uploads', 'apk', deletedVersion.fileName);
    if (fs.existsSync(apkPath)) {
      fs.unlinkSync(apkPath);
    }
    
    res.status(200).json({
      status: true,
      message: 'App version deleted successfully',
      data: deletedVersion
    });
  } catch (error) {
    console.error('Delete version error:', error);
    
    if (error.message === 'Invalid version ID' || error.message === 'Version not found') {
      return res.status(404).json({
        status: false,
        message: error.message
      });
    }
    
    res.status(500).json({
      status: false,
      message: 'Failed to delete app version'
    });
  }
};

/**
 * Download APK file
 * GET /api/app-version/download/:id
 */
exports.downloadApk = async (req, res) => {
  try {
    const { id } = req.params;
    
    const version = await getAppVersionById(id);
    
    if (!version) {
      return res.status(404).json({
        status: false,
        message: 'Version not found'
      });
    }
    
    const apkPath = path.join(__dirname, '..', '..', 'uploads', 'apk', version.fileName);
    
    // Check if file exists
    if (!fs.existsSync(apkPath)) {
      return res.status(404).json({
        status: false,
        message: 'APK file not found on server'
      });
    }
    
    // Set headers for download
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="app-v${version.version}.apk"`);
    
    // Stream the file
    const fileStream = fs.createReadStream(apkPath);
    fileStream.pipe(res);
    
    fileStream.on('error', (error) => {
      console.error('File stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          status: false,
          message: 'Error downloading file'
        });
      }
    });
  } catch (error) {
    console.error('Download APK error:', error);
    
    if (error.message === 'Invalid version ID' || error.message === 'Version not found') {
      return res.status(404).json({
        status: false,
        message: error.message
      });
    }
    
    res.status(500).json({
      status: false,
      message: 'Failed to download APK'
    });
  }
};
