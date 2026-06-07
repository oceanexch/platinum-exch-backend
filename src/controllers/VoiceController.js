const fs = require('fs');
const path = require('path');
const User = require('../models/UserModel');
const VoiceContext = require('../models/VoiceContextModel');

exports.getLearnedContext = async (req, res) => {
    try {
        const userId = req.user.userId || req.user._id;
        let context = await VoiceContext.findOne({ userId });
        
        if (!context) {
            context = await VoiceContext.create({ userId });
        }
        
        res.status(200).json({ success: true, data: context });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get context' });
    }
};

exports.updateLearnedContext = async (req, res) => {
    try {
        const userId = req.user.userId || req.user._id;
        const { scriptId, clientId, learnedSynonym, searchContext } = req.body;
        
        let context = await VoiceContext.findOne({ userId });
        if (!context) {
            context = await VoiceContext.create({ userId });
        }
        
        // 1. Update script frequency
        if (scriptId) {
            const currentFreq = context.scriptFrequency.get(scriptId) || 0;
            context.scriptFrequency.set(scriptId, currentFreq + 1);
        }
        
        // 2. Update client frequency
        if (clientId) {
            const currentFreq = context.clientFrequency.get(clientId) || 0;
            context.clientFrequency.set(clientId, currentFreq + 1);
        }
        
        // 3. Update learned synonyms (misheard -> intended)
        if (learnedSynonym && learnedSynonym.misheard && learnedSynonym.intended) {
            context.synonymMap.set(learnedSynonym.misheard.toLowerCase(), learnedSynonym.intended);
        }
        
        // 4. Update last searched context
        if (searchContext) {
            context.lastSearchedScript = searchContext;
        }
        
        context.updatedAt = new Date();
        await context.save();
        
        res.status(200).json({ success: true, data: context });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update context' });
    }
};

exports.saveRecording = async (req, res) => {
    try {
        const { audioData, transcript } = req.body;
        if (!audioData) return res.status(400).json({ message: 'No audio data provided' });

        const userId = req.user.userId || req.user._id;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const accountFolder = user._id.toString();
        const baseDir = path.resolve(__dirname, '../../uploads/voice_recordings');
        const userDir = path.join(baseDir, accountFolder);

        if (!fs.existsSync(userDir)) {
            await fs.promises.mkdir(userDir, { recursive: true });
        }

        // Robust unique filename: timestamp (Date.now() for maximum precision) + random ID
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        const randomID = Math.random().toString(36).substring(7);
        const fileName = `${timestamp}_${randomID}.webm`;
        const filePath = path.join(userDir, fileName);

        // Process audio data
        const base64Data = audioData.replace(/^data:audio\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        await fs.promises.writeFile(filePath, buffer);

        // Save metadata if transcript exists
        if (transcript) {
            const metaPath = filePath.replace('.webm', '.json');
            const metadata = {
                ts: now,
                transcript,
                accountCode: user.accountCode,
                accountName: user.accountName,
                userId: user._id
            };
            await fs.promises.writeFile(metaPath, JSON.stringify(metadata, null, 2));
        }

        res.status(200).json({ 
            success: true, 
            message: 'Voice recording saved successfully', 
            data: {
                fileName,
                path: `/uploads/voice_recordings/${accountFolder}/${fileName}`,
                timestamp: now
            }
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: 'Failed to save recording',
            error: error.message 
        });
    }
};

/**
 * Get all voice recordings for the user (or all if admin)
 */
exports.getRecordings = async (req, res) => {
    try {
        const requesterId = req.user.userId || req.user._id;
        const requester = await User.findById(requesterId).populate('accountType');
        
        if (!requester) return res.status(404).json({ message: 'User not found' });

        const isAdmin = requester.accountType && requester.accountType.name === 'Admin';
        const baseDir = path.resolve(__dirname, '../../uploads/voice_recordings');

        if (!fs.existsSync(baseDir)) {
            return res.status(200).json({ success: true, data: [] });
        }

        let recordings = [];

        let foldersToScan = [];
        if (isAdmin) {
            foldersToScan = fs.readdirSync(baseDir).filter(f => fs.statSync(path.join(baseDir, f)).isDirectory());
        } else {
            // Find all downline user IDs
            const downlineUsers = await User.find({ parentIds: requesterId }).select('_id').lean();
            foldersToScan = [requesterId.toString(), ...downlineUsers.map(u => u._id.toString())];
        }

        for (const folder of foldersToScan) {
            const userDir = path.join(baseDir, folder);
            if (!fs.existsSync(userDir)) continue;

            const files = fs.readdirSync(userDir).filter(f => f.endsWith('.webm'));
            
            for (const file of files) {
                const filePath = path.join(userDir, file);
                const metaPath = filePath.replace('.webm', '.json');
                let metadata = {};

                if (fs.existsSync(metaPath)) {
                    try {
                        metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    } catch (e) {
                        // Suppressed error log per user request
                    }
                }

                recordings.push({
                    userId: folder,
                    fileName: file,
                    transcript: metadata.transcript || '',
                    timestamp: metadata.ts || fs.statSync(filePath).mtime,
                    accountCode: metadata.accountCode || '',
                    accountName: metadata.accountName || '',
                    link: `/uploads/voice_recordings/${folder}/${file}`
                });
            }
        }

        recordings.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.status(200).json({ success: true, data: recordings });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get recordings' });
    }
};
