#!/usr/bin/env node

// Production startup script
import 'dotenv/config';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

// Check if FFmpeg is available
function checkFFmpeg() {
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ['-version'], { stdio: 'pipe' });
    ffmpeg.on('close', (code) => {
      resolve(code === 0);
    });
    ffmpeg.on('error', () => {
      resolve(false);
    });
  });
}

// Check if temp directory exists
function checkTempDir() {
  return existsSync('./temp');
}

async function startServer() {
  console.log('🎬 FFmpeg Video Generator - Starting...');
  
  // Pre-flight checks
  const ffmpegAvailable = await checkFFmpeg();
  if (!ffmpegAvailable) {
    console.error('❌ FFmpeg not found in PATH. Please install FFmpeg and try again.');
    process.exit(1);
  }
  
  const tempDirExists = checkTempDir();
  if (!tempDirExists) {
    console.error('❌ Temp directory not found. Please ensure temp/ directory exists.');
    process.exit(1);
  }
  
  // Check Supabase environment variables
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('❌ Missing Supabase environment variables. Please check your .env file.');
    console.error('   Required: SUPABASE_URL and SUPABASE_ANON_KEY');
    process.exit(1);
  }
  
  console.log('✅ FFmpeg available');
  console.log('✅ Temp directory ready');
  console.log('✅ Supabase configuration found');
  console.log('🚀 Starting server...\n');
  
  // Start the main server
  const server = spawn('node', ['server.js'], { 
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' }
  });
  
  server.on('close', (code) => {
    console.log(`\n📊 Server exited with code ${code}`);
  });
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.kill('SIGINT');
  });
}

startServer().catch(console.error);