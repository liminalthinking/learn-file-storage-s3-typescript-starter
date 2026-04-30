import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from 'node:path';
import { randomBytes } from "node:crypto";

const MAX_UPLOAD_SIZE = 10 << 20;

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

// const videoThumbnails: Map<string, Thumbnail> = new Map();

// export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
//   const { videoId } = req.params as { videoId?: string };
//   if (!videoId) {
//     throw new BadRequestError("Invalid video ID");
//   }

//   const video = getVideo(cfg.db, videoId);
//   if (!video) {
//     throw new NotFoundError("Couldn't find video");
//   }

//   const thumbnail = videoThumbnails.get(videoId);
//   if (!thumbnail) {
//     throw new NotFoundError("Thumbnail not found");
//   }

//   return new Response(thumbnail.data, {
//     headers: {
//       "Content-Type": thumbnail.mediaType,
//       "Cache-Control": "no-store",
//     },
//   });
// }

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here
  const formData = await req.formData()
  const file = formData.get('thumbnail');
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing")
  }  
  
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File is too large")
  }
  const media_type = file.type;
  const parts = media_type.split("/")
  const real_type = parts[1];
  if ((media_type !=  "image/jpeg") && (media_type != "image/png")) {
    throw new BadRequestError("Wrong file type")
  }
  const image_data = await file.arrayBuffer()
  // const data_string = Buffer.from(image_data).toString("base64")
  // const data_file_type = typeof(data_string);
  const new_path = randomBytes(32).toString("base64");
  const image_path = `${path.join(cfg.assetsRoot, new_path)}.${real_type}`;
  // const image_path = `${path.join(cfg.assetsRoot, videoId)}.${real_type}`;
  console.log("the path to write to is:", image_path)
  Bun.write(image_path, image_data)
  const video = getVideo(cfg.db, videoId)
  // const user = await getUser(cfg.db, video_metadata.userID);
  
  if (video?.userID != userID) {
    throw new UserForbiddenError("...");
  }
  // const data_url = `data:${media_type};base64,${data_string}`;

  // videoThumbnails.set(video.id, {
  //   data: image_data,
  //   mediaType: media_type
  // });

  // const thumbnail_url = `http://localhost:${cfg.port}/api/thumbnails/${video.id}`;
  const thumbnail_url = `http://localhost:${cfg.port}/${image_path}`;
  // const thumbnail_url = data_url;
  

  video.thumbnailURL = thumbnail_url

  updateVideo(cfg.db, video)

  return respondWithJSON(200, video);
}
