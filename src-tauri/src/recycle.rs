//! Windows recycle-only operation; no permanent-delete fallback.
use std::path::Path;

#[cfg(windows)]
pub(crate) fn recycle(path: &Path, permitted: impl Fn() -> bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize, IBindCtx,
            },
            UI::Shell::{
                FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOFX_ADDUNDORECORD,
                FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FileOperation, IFileOperation,
                IFileOperationProgressSink, IShellItem, SHCreateItemFromParsingName,
            },
        },
        core::{IUnknown, PCWSTR},
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
    // Canonicalization uses a verbatim Win32 prefix. Shell parsing expects the
    // ordinary drive/UNC spelling; this conversion does not change the target.
    if name.starts_with(&[92, 92, 63, 92, 85, 78, 67, 92]) {
        drop(name.splice(..8, [92, 92]));
    } else if name.starts_with(&[92, 92, 63, 92]) {
        drop(name.drain(..4));
    }
    name.push(0);
    // Call only from a blocking worker thread. COM
    // references drop before the balanced apartment guard on every exit.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let _apartment = Apartment;
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None::<&IUnknown>, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        operation
            .SetOperationFlags(
                FOFX_RECYCLEONDELETE
                    | FOFX_ADDUNDORECORD
                    | FOFX_EARLYFAILURE
                    | FOF_NOCONFIRMATION
                    | FOF_NOERRORUI
                    | FOF_SILENT,
            )
            .map_err(|e| e.to_string())?;
        let item: IShellItem =
            SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None::<&IBindCtx>)
                .map_err(|e| e.to_string())?;
        operation
            .DeleteItem(&item, None::<&IFileOperationProgressSink>)
            .map_err(|e| e.to_string())?;
        // DeleteItem declares work only. Recheck after potentially slow Shell
        // initialization and immediately before the actual operation starts.
        if !permitted() {
            return Err("Recycle operation was cancelled or the target changed".into());
        }
        operation.PerformOperations().map_err(|e| e.to_string())?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|e| e.to_string())?
            .as_bool()
        {
            return Err("Windows cancelled the recycle operation".into());
        }
    }
    Ok(())
}
#[cfg(not(windows))]
pub(crate) fn recycle(_path: &Path, _permitted: impl Fn() -> bool) -> Result<(), String> {
    Err("Recycle-only cleanup is supported on Windows".into())
}
