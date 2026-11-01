//! Plain Windows object identity for scope/replacement checks. First 20 bytes bind volume, index and creation time.
use std::path::Path;

pub(crate) fn identity(path: &Path) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        use std::{
            fs,
            os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        };
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
                FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
            },
        };
        let file = fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES.0)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)
            .map_err(|e| e.to_string())?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
            .map_err(|e| e.to_string())?;
        if info.dwFileAttributes & 0x400 != 0
            || (info.dwFileAttributes & 0x10 == 0 && info.nNumberOfLinks != 1)
        {
            return Err("Linked or redirected files are not supported for this operation".into());
        }
        Ok([
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
            info.ftCreationTime.dwHighDateTime,
            info.ftCreationTime.dwLowDateTime,
            info.ftLastWriteTime.dwHighDateTime,
            info.ftLastWriteTime.dwLowDateTime,
            info.nFileSizeHigh,
            info.nFileSizeLow,
            info.dwFileAttributes,
        ]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Plain file identity checks require Windows".into())
    }
}
