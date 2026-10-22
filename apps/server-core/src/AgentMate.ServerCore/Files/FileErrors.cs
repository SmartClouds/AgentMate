using System.Text.Json.Serialization;

namespace AgentMate.ServerCore.Files;

/// <summary>
/// Why a file call failed, in words the app maps onto its own (SFTP status codes, the transfer
/// queue's retry rules). The hub sends it as "[files:code] sentence" in the message; REST sends it
/// as JSON with a status code that fits.
/// </summary>
internal enum FileErrorCode
{
    NotFound,
    PermissionDenied,
    Exists,
    NotEmpty,
    IsDirectory,
    NotDirectory,
    Unsupported,
    InvalidInput,

    /// <summary>The session is unknown, expired, or someone else's.</summary>
    SessionGone,

    /// <summary>The container or volume is not there any more.</summary>
    TargetGone,
    DiskFull,
    Server,
}

/// <summary>A file call that failed for a reason the person can act on, with the sentence to show.</summary>
internal sealed class FileOperationException(FileErrorCode code, string message, Exception? inner = null) : Exception(message, inner)
{
    public FileErrorCode Code { get; } = code;

    /// <summary>The code as it travels: camelCase, as in "notFound".</summary>
    public string CodeName => Name(Code);

    /// <summary>The hub's message: "[files:notFound] There is nothing at /etc/x."</summary>
    public string Coded => $"[files:{CodeName}] {Message}";

    public int HttpStatus => Code switch
    {
        FileErrorCode.NotFound => StatusCodes.Status404NotFound,
        FileErrorCode.PermissionDenied => StatusCodes.Status403Forbidden,
        FileErrorCode.Exists or FileErrorCode.NotEmpty or FileErrorCode.IsDirectory or FileErrorCode.NotDirectory => StatusCodes.Status409Conflict,
        FileErrorCode.Unsupported or FileErrorCode.InvalidInput => StatusCodes.Status400BadRequest,
        FileErrorCode.SessionGone or FileErrorCode.TargetGone => StatusCodes.Status410Gone,
        FileErrorCode.DiskFull => StatusCodes.Status507InsufficientStorage,
        _ => StatusCodes.Status500InternalServerError,
    };

    public static string Name(FileErrorCode code)
    {
        var name = code.ToString();
        return char.ToLowerInvariant(name[0]) + name[1..];
    }
}

/// <summary>A REST refusal's body.</summary>
internal sealed record FileErrorBody(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message);
