export const convertToWav = async (inputPath, outputPath) => {
    // In SDK 55 (2026), whisper.rn handles its own decoding.
    // This function is now a passthrough for backward compatibility.
    console.log(`Bypassing FFmpeg conversion for modern whisper.rn: ${inputPath}`);
    return inputPath;
};
