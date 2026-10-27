//! User-triggered monitor capture. No game process, graphics hooks or input automation.

#[cfg(windows)]
pub fn capture_screen_under_cursor() -> Result<Vec<u8>, String> {
    use image::ImageEncoder;
    use std::{ffi::c_void, mem::size_of, ptr::null_mut};
    use windows_sys::Win32::{
        Foundation::POINT,
        Graphics::Gdi::*,
        UI::{HiDpi::*, WindowsAndMessaging::GetPhysicalCursorPos},
    };

    struct Dpi(DPI_AWARENESS_CONTEXT);
    impl Drop for Dpi {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    SetThreadDpiAwarenessContext(self.0);
                }
            }
        }
    }
    struct Screen(HDC);
    impl Drop for Screen {
        fn drop(&mut self) {
            unsafe {
                ReleaseDC(null_mut(), self.0);
            }
        }
    }
    struct Memory(HDC);
    impl Drop for Memory {
        fn drop(&mut self) {
            unsafe {
                DeleteDC(self.0);
            }
        }
    }
    struct Bitmap(HBITMAP);
    impl Drop for Bitmap {
        fn drop(&mut self) {
            unsafe {
                DeleteObject(self.0);
            }
        }
    }
    struct Selection(HDC, HGDIOBJ);
    impl Drop for Selection {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.0, self.1);
            }
        }
    }
    let failed =
        |operation: &str| format!("{operation} failed: {}", std::io::Error::last_os_error());

    // These FFI values are OS-owned handles or correctly sized C structs. Guards
    // restore DPI/object selection before deleting GDI resources on every exit.
    unsafe {
        let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if previous.is_null() {
            return Err(failed("SetThreadDpiAwarenessContext"));
        }
        let _dpi = Dpi(previous);
        let mut cursor = POINT { x: 0, y: 0 };
        if GetPhysicalCursorPos(&mut cursor) == 0 {
            return Err(failed("GetPhysicalCursorPos"));
        }
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return Err(failed("MonitorFromPoint"));
        }
        let mut monitor_info: MONITORINFO = std::mem::zeroed();
        monitor_info.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut monitor_info) == 0 {
            return Err(failed("GetMonitorInfoW"));
        }
        let bounds = monitor_info.rcMonitor;
        let width = bounds
            .right
            .checked_sub(bounds.left)
            .ok_or("Invalid monitor bounds")?;
        let height = bounds
            .bottom
            .checked_sub(bounds.top)
            .ok_or("Invalid monitor bounds")?;
        if width <= 0
            || height <= 0
            || u64::from(width as u32) * u64::from(height as u32) > 40_000_000
        {
            return Err("Monitor dimensions exceed the capture memory budget".into());
        }
        let screen = GetDC(null_mut());
        if screen.is_null() {
            return Err(failed("GetDC"));
        }
        let screen = Screen(screen);
        let memory = CreateCompatibleDC(screen.0);
        if memory.is_null() {
            return Err(failed("CreateCompatibleDC"));
        }
        let memory = Memory(memory);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height; // Top-down DIB: negative-coordinate monitors need no special flip.
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut pixels: *mut c_void = null_mut();
        let bitmap = CreateDIBSection(screen.0, &info, DIB_RGB_COLORS, &mut pixels, null_mut(), 0);
        if bitmap.is_null() {
            return Err(failed("CreateDIBSection"));
        }
        let bitmap = Bitmap(bitmap);
        if pixels.is_null() {
            return Err("CreateDIBSection returned no pixels".into());
        }
        let old = SelectObject(memory.0, bitmap.0);
        if old.is_null() || old as isize == -1 {
            return Err(failed("SelectObject"));
        }
        let _selection = Selection(memory.0, old);
        if BitBlt(
            memory.0,
            0,
            0,
            width,
            height,
            screen.0,
            bounds.left,
            bounds.top,
            SRCCOPY | CAPTUREBLT,
        ) == 0
        {
            return Err(failed("BitBlt"));
        }
        if GdiFlush() == 0 {
            return Err(failed("GdiFlush"));
        }
        let length = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or("Capture size overflow")?;
        let mut rgba = std::slice::from_raw_parts(pixels.cast::<u8>(), length).to_vec();
        for pixel in rgba.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                &rgba,
                width as u32,
                height as u32,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| format!("PNG encoding failed: {error}"))?;
        Ok(png)
    }
}

#[cfg(not(windows))]
pub fn capture_screen_under_cursor() -> Result<Vec<u8>, String> {
    Err("Native screen capture is currently supported on Windows only".into())
}
