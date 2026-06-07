const AppVersionModel = require('../models/AppVersionModel');
const mongoose = require('mongoose');

/**
 * Create a new app version
 * @param {Object} versionData - Version data
 * @returns {Promise<Object>} Created version document
 */
exports.createAppVersion = async (versionData) => {
  try {
    const newVersion = new AppVersionModel(versionData);
    await newVersion.save();
    return newVersion;
  } catch (error) {
    if (error.code === 11000) {
      throw new Error('Version already exists');
    }
    throw error;
  }
};

/**
 * Get all app versions with optional filters
 * @param {Object} filters - Query filters
 * @returns {Promise<Array>} Array of version documents
 */
exports.getAllAppVersions = async (filters = {}) => {
  try {
    const query = {};
    
    if (filters.platform && filters.platform !== 'both') {
      query.$or = [
        { platform: filters.platform },
        { platform: 'both' }
      ];
    }
    
    if (filters.isActive !== undefined) {
      query.isActive = filters.isActive;
    }
    
    const versions = await AppVersionModel.find(query)
      .populate('createdBy', 'accountName accountCode')
      .populate('updatedBy', 'accountName accountCode')
      .sort({ createdAt: -1 });
    
    return versions;
  } catch (error) {
    throw error;
  }
};

/**
 * Get app version by ID
 * @param {String} versionId - Version ID
 * @returns {Promise<Object>} Version document
 */
exports.getAppVersionById = async (versionId) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(versionId)) {
      throw new Error('Invalid version ID');
    }
    
    const version = await AppVersionModel.findById(versionId)
      .populate('createdBy', 'accountName accountCode')
      .populate('updatedBy', 'accountName accountCode');
    
    if (!version) {
      throw new Error('Version not found');
    }
    
    return version;
  } catch (error) {
    throw error;
  }
};

/**
 * Get latest active version for a platform
 * @param {String} platform - Platform (android/ios/both)
 * @returns {Promise<Object>} Latest version document
 */
exports.getLatestVersion = async (platform = 'both') => {
  try {
    const query = { isActive: true };
    
    if (platform && platform !== 'both') {
      query.$or = [
        { platform: platform },
        { platform: 'both' }
      ];
    }
    
    const version = await AppVersionModel.findOne(query)
      .sort({ createdAt: -1 })
      .populate('createdBy', 'accountName accountCode');
    
    return version;
  } catch (error) {
    throw error;
  }
};

/**
 * Update app version
 * @param {String} versionId - Version ID
 * @param {Object} updateData - Data to update
 * @returns {Promise<Object>} Updated version document
 */
exports.updateAppVersion = async (versionId, updateData) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(versionId)) {
      throw new Error('Invalid version ID');
    }
    
    const version = await AppVersionModel.findByIdAndUpdate(
      versionId,
      { $set: updateData },
      { new: true, runValidators: true }
    )
      .populate('createdBy', 'accountName accountCode')
      .populate('updatedBy', 'accountName accountCode');
    
    if (!version) {
      throw new Error('Version not found');
    }
    
    return version;
  } catch (error) {
    if (error.code === 11000) {
      throw new Error('Version already exists');
    }
    throw error;
  }
};

/**
 * Delete app version
 * @param {String} versionId - Version ID
 * @returns {Promise<Object>} Deleted version document
 */
exports.deleteAppVersion = async (versionId) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(versionId)) {
      throw new Error('Invalid version ID');
    }
    
    const version = await AppVersionModel.findByIdAndDelete(versionId);
    
    if (!version) {
      throw new Error('Version not found');
    }
    
    return version;
  } catch (error) {
    throw error;
  }
};

/**
 * Check if version update is required
 * @param {String} currentVersion - Current app version
 * @param {String} platform - Platform (android/ios)
 * @param {String} baseUrl - Base URL for download link
 * @returns {Promise<Object>} Update info
 */
exports.checkVersionUpdate = async (currentVersion, platform, baseUrl) => {
  try {
    const latestVersion = await this.getLatestVersion(platform);
    
    if (!latestVersion) {
      return {
        updateRequired: false,
        message: 'No version information available'
      };
    }
    
    const isUpdateRequired = compareVersions(currentVersion, latestVersion.version) < 0;
    const isMandatory = latestVersion.isMandatory && 
                        latestVersion.minSupportedVersion && 
                        compareVersions(currentVersion, latestVersion.minSupportedVersion) < 0;
    
    return {
      updateRequired: isUpdateRequired,
      isMandatory: isMandatory,
      latestVersion: latestVersion.version,
      downloadLink: `${baseUrl}/api/app-version/download/${latestVersion._id}`,
      releaseNotes: latestVersion.releaseNotes,
      fileSize: latestVersion.fileSize,
      message: isUpdateRequired 
        ? (isMandatory ? 'Mandatory update required' : 'Update available')
        : 'App is up to date'
    };
  } catch (error) {
    throw error;
  }
};

/**
 * Compare two semantic versions
 * @param {String} v1 - Version 1
 * @param {String} v2 - Version 2
 * @returns {Number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < 3; i++) {
    if (parts1[i] < parts2[i]) return -1;
    if (parts1[i] > parts2[i]) return 1;
  }
  
  return 0;
}
