using AgentMate.ServerCore.Uploads;

namespace AgentMate.ServerCore.Files;

/// <param name="Body">Exactly the entry's contents; reading past them returns 0.</param>
internal sealed record UnwrappedFile(TarEntryHeader Header, Stream Body);

/// <summary>
/// Takes the first entry out of the archive API's tar of one path, the way a download needs it:
/// its header (size, mode, owner, time) and its contents as a stream that ends with the entry.
/// A folder, a link or a special file is refused, since there are no contents to send.
/// </summary>
internal static class ArchiveUnwrap
{
    public static async Task<UnwrappedFile> ReadFirstFileAsync(Stream archive, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(archive);
        var reader = new TarStreamReader(archive);
        TarEntryHeader? header;
        do
        {
            header = await reader.ReadNextAsync(cancellationToken);
        }
        while (header is { Type: 'g' });

        return header switch
        {
            null => throw new InvalidDataException("The archive Docker sent has no entry in it."),
            { Type: '5' } => throw new FileOperationException(FileErrorCode.IsDirectory, "That is a folder. Download the files in it instead."),
            { Type: '0' or '7' } => new UnwrappedFile(header, new EntryBody(reader)),
            _ => throw new FileOperationException(FileErrorCode.Unsupported, "That is a link or a special file, not a file with contents to download."),
        };
    }

    private sealed class EntryBody(TarStreamReader reader) : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) =>
            reader.ReadContentAsync(buffer.AsMemory(offset, count), CancellationToken.None).AsTask().GetAwaiter().GetResult();

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            reader.ReadContentAsync(buffer, cancellationToken);

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            reader.ReadContentAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
