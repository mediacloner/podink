import { FFmpegKit, ReturnCode } from 'ffmpeg-kit-react-native';

export const convertToWav = async (inputPath, outputPath) => {
    // whisper.cpp requires standard 16-bit 16kHz WAV format
    const command = `-i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}" -y`;
    
    try {
        const session = await FFmpegKit.execute(command);
        const returnCode = await session.getReturnCode();

        if (ReturnCode.isSuccess(returnCode)) {
            console.log(`Successfully transcoded audio to 16kHz WAV at: ${outputPath}`);
            return outputPath;
        } else {
            const logs = await session.getLogsAsString();
            throw new Error(`FFmpeg failed: ${logs}`);
        }
    } catch (error) {
        console.error('Audio conversion failed', error);
        throw error;
    }
};
