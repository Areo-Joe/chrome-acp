//! Zed 62682ebde9 language_model/src/request.rs image preparation.
//! Both application hosts use this implementation, including the Rust image
//! decoder, Triangle filter, PNG encoder and binary-byte size limit.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{GenericImageView, codecs::png::PngEncoder, imageops::FilterType};
use serde_json::{Value, json};

const DIMENSION_LIMIT: u32 = 1568;
const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_PASSES: usize = 8;

pub fn normalize(request: &Value) -> Result<Value, String> {
    let bytes = if let Some(path) = request["path"].as_str() {
        if !std::path::Path::new(path).is_absolute() {
            return Err("Expected an absolute image path".into());
        }
        match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) if request["inspect"] == true => return Ok(json!({ "supported": false })),
            Err(error) => return Err(error.to_string()),
        }
    } else {
        STANDARD
            .decode(request["data"].as_str().ok_or("Missing image data")?)
            .map_err(|e| e.to_string())?
    };
    // External files are identified by their contents in Zed's
    // load_external_image_from_path. Names and platform MIME aliases are labels.
    let detected = image::guess_format(&bytes).ok().filter(|format| {
        matches!(
            format,
            image::ImageFormat::Png
                | image::ImageFormat::Jpeg
                | image::ImageFormat::WebP
                | image::ImageFormat::Gif
                | image::ImageFormat::Bmp
                | image::ImageFormat::Tiff
                | image::ImageFormat::Ico
                | image::ImageFormat::Pnm
        )
    });
    if request["inspect"] == true {
        return Ok(match detected {
            Some(_) => json!({ "supported": true, "data": STANDARD.encode(&bytes) }),
            None => json!({ "supported": false }),
        });
    }
    let format = detected.ok_or("Failed to convert image")?;
    let mut image =
        image::load_from_memory_with_format(&bytes, format).map_err(|e| e.to_string())?;
    if image.width() > DIMENSION_LIMIT || image.height() > DIMENSION_LIMIT {
        // GPUI ObjectFit::ScaleDown computes f32 bounds. Pixels -> u32 then
        // truncates each bound before DynamicImage::resize preserves its ratio.
        let (width, height) = (image.width() as f32, image.height() as f32);
        let limit = DIMENSION_LIMIT as f32;
        let (width, height) = if width / height > 1.0 {
            (DIMENSION_LIMIT, (height * (limit / width)) as u32)
        } else {
            ((width * (limit / height)) as u32, DIMENSION_LIMIT)
        };
        image = image.resize(width, height, FilterType::Triangle);
    }
    let encode = |image: &image::DynamicImage| -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        image
            .write_with_encoder(PngEncoder::new(&mut bytes))
            .map_err(|e| e.to_string())?;
        Ok(bytes)
    };
    let mut png = encode(&image)?;
    for _ in 0..MAX_PASSES {
        if png.len() <= MAX_BYTES {
            break;
        }
        let (width, height) = image.dimensions();
        if width <= 1 || height <= 1 {
            break;
        }
        let width = ((width as f32) * 0.85).round().max(1.0) as u32;
        let height = ((height as f32) * 0.85).round().max(1.0) as u32;
        image = image.resize(width, height, FilterType::Triangle);
        png = encode(&image)?;
    }
    if png.len() > MAX_BYTES {
        return Err("Failed to convert image".into());
    }
    Ok(
        json!({ "data": STANDARD.encode(&png), "mimeType": "image/png", "width": image.width(), "height": image.height() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prepare(image: image::DynamicImage, format: image::ImageFormat) -> Value {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        normalize(&json!({ "data": STANDARD.encode(bytes.into_inner()) })).unwrap()
    }
    #[test]
    fn converts_jpeg_and_scales_to_zed_bounds() {
        let input = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            1600,
            800,
            image::Rgb([12, 34, 56]),
        ));
        let result = prepare(input, image::ImageFormat::Jpeg);
        assert_eq!(result["mimeType"], "image/png");
        assert_eq!(
            (result["width"].as_u64(), result["height"].as_u64()),
            (Some(1568), Some(784))
        );
        let bytes = STANDARD.decode(result["data"].as_str().unwrap()).unwrap();
        assert_eq!(
            image::guess_format(&bytes).unwrap(),
            image::ImageFormat::Png
        );
    }
    #[test]
    fn png_preserves_rgba_and_does_not_upscale() {
        let input = image::RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 40]));
        let result = prepare(
            image::DynamicImage::ImageRgba8(input.clone()),
            image::ImageFormat::Png,
        );
        let bytes = STANDARD.decode(result["data"].as_str().unwrap()).unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().into_rgba8(), input);
    }
    #[test]
    fn gpui_fractional_bounds_truncate_before_resize() {
        let image = image::DynamicImage::new_rgb8(1569, 500);
        let result = prepare(image, image::ImageFormat::Png);
        assert_eq!(
            (result["width"].as_u64(), result["height"].as_u64()),
            (Some(1566), Some(499))
        );
    }
    #[test]
    fn enforces_binary_png_limit_before_base64() {
        let mut state = 123456789u32;
        let image = image::RgbaImage::from_fn(1568, 1568, |_, _| {
            let mut pixel = [0; 4];
            for byte in &mut pixel {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *byte = state as u8;
            }
            image::Rgba(pixel)
        });
        let result = prepare(
            image::DynamicImage::ImageRgba8(image),
            image::ImageFormat::Png,
        );
        assert!(result["width"].as_u64().unwrap() < 1568);
        assert!(
            STANDARD
                .decode(result["data"].as_str().unwrap())
                .unwrap()
                .len()
                <= MAX_BYTES
        );
    }
    #[test]
    fn failures_are_explicit() {
        for value in [
            json!({}),
            json!({"data":"invalid"}),
            json!({"data":"YWJj"}),
            json!({"path":"relative.png"}),
        ] {
            assert!(normalize(&value).is_err());
        }
    }
    #[test]
    fn external_content_determines_format_despite_name_and_mime() {
        let png = prepare(image::DynamicImage::new_rgb8(2, 2), image::ImageFormat::Png);
        assert!(
            normalize(
                &json!({"data":png["data"], "fileName":"wrong.jpg", "mimeType":"image/jpeg"})
            )
            .is_ok()
        );
        assert!(normalize(&json!({"data":png["data"], "mimeType":"image/svg+xml"})).is_ok());
        assert!(normalize(&json!({"data":png["data"], "mimeType":"image/png"})).is_ok());
    }
    #[test]
    fn native_file_input_uses_the_same_decoder_and_encoder() {
        let png = prepare(
            image::DynamicImage::new_rgba8(3, 2),
            image::ImageFormat::Png,
        );
        let path = std::env::temp_dir().join(format!(
            "nsh-image-codec-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &path,
            STANDARD.decode(png["data"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let result = normalize(&json!({"path":path}));
        std::fs::remove_file(path).unwrap();
        assert_eq!(result.unwrap(), png);
    }
    #[test]
    fn external_probe_filters_unrecognized_content_before_conversion() {
        assert_eq!(
            normalize(&json!({"inspect":true, "data":STANDARD.encode(b"plain text")})).unwrap(),
            json!({"supported":false})
        );
        let png = prepare(image::DynamicImage::new_rgb8(2, 2), image::ImageFormat::Png);
        assert_eq!(
            normalize(&json!({"inspect":true, "data":png["data"], "fileName":"wrong.jpg"}))
                .unwrap(),
            json!({"supported":true, "data":png["data"]})
        );
        // Recognition retains Zed's distinction: recognized, corrupt images
        // still fail conversion after their mention has been inserted.
        let truncated = STANDARD.encode(b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            normalize(&json!({"inspect":true, "data":truncated})).unwrap(),
            json!({"supported":true, "data":truncated})
        );
        assert!(normalize(&json!({"data":truncated})).is_err());
    }
    #[test]
    fn picker_files_accept_platform_mime_aliases() {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(3, 2)
            .write_to(&mut bytes, image::ImageFormat::Bmp)
            .unwrap();
        let result = normalize(&json!({"fileName":"image.bmp", "mimeType":"image/x-ms-bmp", "data":STANDARD.encode(bytes.into_inner())})).unwrap();
        assert_eq!(result["mimeType"], "image/png");
        assert_eq!(result["width"], 3);
    }
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_chromeacp_nshclient_ImageCodec_normalize(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    request: jni::objects::JString,
) -> jni::sys::jstring {
    let result = (|| -> Result<_, String> {
        let request: String = env.get_string(&request).map_err(|e| e.to_string())?.into();
        let value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
        let result = normalize(&value)?.to_string();
        env.new_string(result).map_err(|e| e.to_string())
    })();
    match result {
        Ok(value) => value.into_raw(),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalArgumentException", error);
            std::ptr::null_mut()
        }
    }
}
