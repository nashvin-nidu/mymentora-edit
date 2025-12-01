// lib/supabaseHelpers.js
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'fs/promises';

// Initialize Supabase client (lazy initialization)
let supabase = null;

function getSupabaseClient() {
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase environment variables: require SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or fallback SUPABASE_ANON_KEY).');
    }

    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

/**
 * Upload a video file to Supabase storage bucket
 * @param {string} filePath - Local path to the video file
 * @param {string} jobId - Job ID to use in the filename
 * @param {string} bucketName - Supabase bucket name (default: 'videos')
 * @returns {Promise<{url: string, path: string}>} - Public URL and storage path
 */
export async function uploadVideoToSupabase(filePath, jobId, bucketName = process.env.SUPABASE_BUCKET_NAME || 'videos') {
  try {
    // Read the file
    const fileBuffer = await readFile(filePath);
    
    // Create filename with jobId
    const fileName = `${jobId}.mp4`;
    
    // Upload to Supabase storage
    const supabaseClient = getSupabaseClient();
    const { data, error } = await supabaseClient.storage
      .from(bucketName)
      .upload(fileName, fileBuffer, {
        contentType: 'video/mp4',
        upsert: true // Overwrite if exists
      });

    if (error) {
      const keyType = process.env.SUPABASE_SERVICE_ROLE_KEY ? 'service-role' : 'anon';
      throw new Error(`Supabase upload failed (${keyType} key) to bucket '${bucketName}', path '${fileName}': ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = supabaseClient.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return {
      url: urlData.publicUrl,
      path: data.path
    };
  } catch (error) {
    console.error('Error uploading to Supabase:', error);
    throw error;
  }
}

/**
 * Delete a video file from Supabase storage
 * @param {string} fileName - Name of the file to delete
 * @param {string} bucketName - Supabase bucket name (default: 'videos')
 * @returns {Promise<boolean>} - Success status
 */
export async function deleteVideoFromSupabase(fileName, bucketName = process.env.SUPABASE_BUCKET_NAME || 'videos') {
  try {
    const supabaseClient = getSupabaseClient();
    const { error } = await supabaseClient.storage
      .from(bucketName)
      .remove([fileName]);

    if (error) {
      console.error('Error deleting from Supabase:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error deleting from Supabase:', error);
    return false;
  }
}