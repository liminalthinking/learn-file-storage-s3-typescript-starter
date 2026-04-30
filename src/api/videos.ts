import { respondWithJSON } from "./json";
import { type Video } from "../db/videos";
import { type ApiConfig } from "../config";
import { s3, S3Client, stringWidth, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import {getVideo, updateVideo } from "../db/videos";
import {randomBytes} from "node:crypto";
import path from 'node:path';
import { stdout } from "node:process";
import { collapseTextChangeRangesAcrossMultipleVersions } from "typescript";

const MAX_VID_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const {videoId} = req.params as {videoId?: string};
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  const video = getVideo(cfg.db, videoId);
  if (video?.userID != userID) {
    throw new UserForbiddenError("User is not correct")
  }

  const formData = await req.formData();
  const file = formData.get('video');

  if (!(file instanceof File)) {
    throw new BadRequestError("File is missing");
  }

  if (file.size > MAX_VID_UPLOAD_SIZE) {
    throw new BadRequestError("File is too large");
  }

  const media_type = file.type;
  const parts = media_type.split('/')
  const real_type = parts[1] 

  if (file.type != "video/mp4") {
    throw new BadRequestError("Wrong file type!");
  }

  const video_data = await file.arrayBuffer();
  //reads the uploaded file into memory as raw bytes
  const new_path = randomBytes(32).toString("hex");
  //generates a random filename-safe ID
  const video_path = `/tmp/${new_path}.${real_type}`;
  //builds a temporary file path
  // processVideoForFastStart(`/tmp/${new_path}.${real_type}`);
  await Bun.write(video_path, video_data);
  //writes the video into the temporary file path
  const fast_video_path = await processVideoForFastStart(video_path);
  //processes video into a fast version, rearranging the mp4 metadata to the front so streaming begins sooner
  const aspect_ratio = await getVideoAspectRatio(fast_video_path);
  //gets aspect based on dimensions
  const path_to_file = `${aspect_ratio}/${new_path}.${real_type}`
  //creates the s3 object key eg. portrait/abc123.mp4

  // dbVideoToSignedVideo

  const video_file_data = Bun.file(fast_video_path)
  //creates file handle for the processed local file
  const s3file = cfg.s3Client.file(path_to_file);
  //creates reference to where it will live in s3
  await s3file.write(video_file_data, {type: "video/mp4"});
  //uploads the processed video to s3 with content type video/mp4
  await Bun.file(video_path).delete()
  await Bun.file(fast_video_path).delete()
  //delete temporary local files (both versions)

  // video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${path_to_file}`
  video.videoURL = path_to_file;
  updateVideo(cfg.db, video);
  // return respondWithJSON(200, null);

  const signedVideo = await dbVideoToSignedVideo(cfg, video)
  //note the db is not updated, this is just to return the video with the signedurl
  return respondWithJSON(200, signedVideo)
}

export async function getVideoAspectRatio(filePath: string) {
  console.log("getVideoAspectRatio called with:", filePath);

  const proc = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const error_code = await proc.exited;
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  console.log("error_code:", error_code)
  console.log("stderr", stderrText);
  console.log("stdout:", stdoutText)
  if (error_code != 0) {
    throw new BadRequestError("Error")
  }
  
  const parsed_output = JSON.parse(stdoutText);
  const video_width = parsed_output.streams[0].width;
  const video_height = parsed_output.streams[0].height;
  const ratio = Math.floor(video_width/video_height);
  if (ratio == Math.floor(16/9)) {
    return "landscape"
  }
  else if (ratio == Math.floor(9/16)) {
    return "portrait"
  }
  else 
    {return "other"}

}

export async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const new_output_file = inputFilePath+'.processed';
  const proc = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    new_output_file
  ],
    {stdout: "pipe"
  });
  
  await proc.exited;
  // const stdoutText = await new Response(proc.stdout).text();
  // const parsed_output = JSON.parse(stdoutText);
  return new_output_file;

}

export async function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  const presigned_key = cfg.s3Client.presign(key);
  return presigned_key;
}

export async function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  if (!video.videoURL) {
    return video;
    // throw new Error("videoURL missing")
  }
  
  const video_url = await generatePresignedURL(cfg, video.videoURL, 30)
  
  video.videoURL = video_url;
  // updateVideo(cfg.db, video);
  return video
}