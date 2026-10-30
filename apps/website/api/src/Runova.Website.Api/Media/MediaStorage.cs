using System.Globalization;
using System.Security.Cryptography;
using Microsoft.Extensions.FileProviders;
using Runova.Website.Core.Media;

namespace Runova.Website.Api.Media;

/// <summary>
/// The media folder (<c>Website:MediaPath</c>, or <c>media</c> under the content root). Files go
/// to <c>yyyy/mm/</c> under a random name; the reverse proxy serves the folder at <c>/media/</c>,
/// and so does the API itself in development.
/// </summary>
internal sealed class MediaStorage(IConfiguration configuration, IWebHostEnvironment environment)
{
    public const string RequestPath = "/media";

    /// <summary>A file never changes once stored: a new upload gets a new name.</summary>
    public const string FileCaching = "public, max-age=31536000, immutable";

    public string Folder { get; } = Path.GetFullPath(configuration["Website:MediaPath"] ?? Path.Combine(environment.ContentRootPath, "media"));

    public static string Url(string siteUrl, MediaFile file) => $"{siteUrl}{RequestPath}/{file.Path}";

    /// <summary>Writes the image and returns its path relative to the folder.</summary>
    public async Task<string> SaveAsync(ProcessedImage image, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var path = string.Create(
            CultureInfo.InvariantCulture,
            $"{now:yyyy}/{now:MM}/{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16))}.{image.Extension}");
        var full = Path.Combine(Folder, path);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        await File.WriteAllBytesAsync(full, image.Bytes, cancellationToken);
        return path;
    }

    public void Delete(string path) => File.Delete(Path.Combine(Folder, path));

    /// <summary>Serves the folder at <c>/media/</c> in development, where no reverse proxy does.</summary>
    public static WebApplication UseMediaFiles(WebApplication app)
    {
        if (app.Environment.IsDevelopment())
        {
            var folder = app.Services.GetRequiredService<MediaStorage>().Folder;
            Directory.CreateDirectory(folder);
            app.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = new PhysicalFileProvider(folder),
                RequestPath = RequestPath,
                OnPrepareResponse = file => file.Context.Response.Headers.CacheControl = FileCaching,
            });
        }

        return app;
    }
}
