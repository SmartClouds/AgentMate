using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.Identity;
using Runova.Website.IntegrationTests.Infrastructure;
using Runova.Website.IntegrationTests.Posts;
using SkiaSharp;
using ApiScopes = Runova.Website.Core.ApiClients.ApiScopes;

namespace Runova.Website.IntegrationTests.Media;

public sealed class MediaUploadTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Media = "/api/v1/media";
    private const int MaxBytes = 5 * 1024 * 1024;

    private static readonly DateTimeOffset _now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    /// <summary>A 1x1 GIF, which Skia reads but does not write.</summary>
    private static readonly byte[] _gif = Convert.FromBase64String("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==");

    private readonly FakeTimeProvider _time = new(_now);
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "runova-media-tests", Guid.NewGuid().ToString("N"));
    private string _database = null!;
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _database = await postgres.CreateDatabaseAsync();
        _factory = Factory("Production");
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        if (Directory.Exists(_folder))
        {
            Directory.Delete(_folder, recursive: true);
        }

        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task A_png_is_stored_under_a_random_name_and_described()
    {
        var editor = await EditorAsync();

        var response = await editor.Http.SendAsync(Upload(editor, Png(40, 20), "cover.png", "image/png", "A blue square"), TestContext.Current.CancellationToken);
        var media = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);

        Assert.Equal(["id", "url", "contentType", "width", "height", "size", "alt", "createdAt"], media.EnumerateObject().Select(p => p.Name));
        Assert.Equal($"/api/v1/media/{media.GetProperty("id").GetInt64()}", response.Headers.Location?.OriginalString);
        Assert.Matches("^https://runovahq\\.com/media/2026/10/[a-z0-9]{32}\\.png$", media.GetProperty("url").GetString());
        Assert.Equal("image/png", media.GetProperty("contentType").GetString());
        Assert.Equal(40, media.GetProperty("width").GetInt32());
        Assert.Equal(20, media.GetProperty("height").GetInt32());
        Assert.Equal("A blue square", media.GetProperty("alt").GetString());
        Assert.Equal("2026-10-30T12:00:00.000Z", media.GetProperty("createdAt").GetString());
        var stored = StoredFile(media);
        Assert.Equal(new FileInfo(stored).Length, media.GetProperty("size").GetInt64());
        Assert.DoesNotContain("cover", Path.GetFileName(stored), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_stored_jpeg_has_no_exif_data()
    {
        var editor = await EditorAsync();
        var jpeg = JpegWithExif();
        Assert.Contains("Runova Test Camera", Encoding.Latin1.GetString(jpeg), StringComparison.Ordinal);

        var media = await ApiClient.ReadJsonAsync(
            await editor.Http.SendAsync(Upload(editor, jpeg, "photo.jpg", "image/jpeg"), TestContext.Current.CancellationToken), HttpStatusCode.Created);

        var stored = await File.ReadAllBytesAsync(StoredFile(media), TestContext.Current.CancellationToken);
        Assert.Equal("image/jpeg", media.GetProperty("contentType").GetString());
        Assert.Equal(SKEncodedImageFormat.Jpeg, SKCodec.Create(SKData.CreateCopy(stored)).EncodedFormat);
        Assert.DoesNotContain("Exif", Encoding.Latin1.GetString(stored), StringComparison.Ordinal);
        Assert.DoesNotContain("Runova Test Camera", Encoding.Latin1.GetString(stored), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("webp", "image/webp", 24, 12)]
    [InlineData("avif", "image/avif", 32, 16)]
    public async Task Webp_and_avif_are_taken_too(string kind, string contentType, int width, int height)
    {
        var editor = await EditorAsync();
        var bytes = kind == "webp" ? Encode(Blank(24, 12), SKEncodedImageFormat.Webp) : await FixtureAsync("cover.avif");

        var media = await ApiClient.ReadJsonAsync(
            await editor.Http.SendAsync(Upload(editor, bytes, "cover.bin", "application/octet-stream"), TestContext.Current.CancellationToken), HttpStatusCode.Created);

        Assert.Equal(contentType, media.GetProperty("contentType").GetString());
        Assert.EndsWith("." + kind, media.GetProperty("url").GetString(), StringComparison.Ordinal);
        Assert.Equal(width, media.GetProperty("width").GetInt32());
        Assert.Equal(height, media.GetProperty("height").GetInt32());
    }

    [Theory]
    [InlineData("disguised")]
    [InlineData("gif")]
    [InlineData("svg")]
    [InlineData("truncated png")]
    public async Task A_wrong_type_or_a_disguised_file_gets_400(string @case)
    {
        var editor = await EditorAsync();
        var bytes = @case switch
        {
            "disguised" => await FixtureAsync("disguised.png"),
            "gif" => _gif,
            "svg" => Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"),
            _ => Png(40, 20)[..40],
        };

        var response = await editor.Http.SendAsync(Upload(editor, bytes, "cover.png", "image/png"), TestContext.Current.CancellationToken);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Media);
        Assert.Equal(["file"], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
        Assert.False(Directory.Exists(_folder) && Directory.EnumerateFiles(_folder, "*", SearchOption.AllDirectories).Any());
    }

    [Fact]
    public async Task A_file_over_5_mb_gets_413()
    {
        var editor = await EditorAsync();
        var bytes = new byte[MaxBytes + 1];
        Png(4, 4).CopyTo(bytes, 0);

        var response = await editor.Http.SendAsync(Upload(editor, bytes, "huge.png", "image/png"), TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.RequestEntityTooLarge, ProblemAssert.Type("payload-too-large"), Media);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public async Task An_upload_with_no_alt_text_gets_400(string? alt)
    {
        var editor = await EditorAsync();

        var response = await editor.Http.SendAsync(Upload(editor, Png(4, 4), "cover.png", "image/png", alt), TestContext.Current.CancellationToken);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Media);
        Assert.Equal(["alt"], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task Only_staff_and_posts_write_clients_may_upload()
    {
        var (newsKey, newsSecret) = await TestApiClients.AddAsync(_factory.Services, scopes: [ApiScopes.NewsWrite]);
        var (postsKey, postsSecret) = await TestApiClients.AddAsync(_factory.Services, scopes: [ApiScopes.PostsWrite]);

        var anonymous = await _factory.CreateApiClient().Http.SendAsync(Upload(null, Png(4, 4), "a.png", "image/png"), TestContext.Current.CancellationToken);
        var newsClient = await TestApiClients.Http(_factory, newsKey, newsSecret).SendAsync(Upload(null, Png(4, 4), "a.png", "image/png"), TestContext.Current.CancellationToken);
        var postsClient = await TestApiClients.Http(_factory, postsKey, postsSecret).SendAsync(Upload(null, Png(4, 4), "a.png", "image/png"), TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        await ProblemAssert.IsProblemAsync(newsClient, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), Media);
        Assert.Equal(HttpStatusCode.Created, postsClient.StatusCode);
    }

    [Fact]
    public async Task A_post_shows_its_cover_image()
    {
        var editor = await EditorAsync();
        var media = await ApiClient.ReadJsonAsync(
            await editor.Http.SendAsync(Upload(editor, Png(40, 20), "cover.png", "image/png", "A blue square"), TestContext.Current.CancellationToken), HttpStatusCode.Created);

        await PostWriteTests.CreateAsync(editor, PostWriteTests.Body("with-a-cover", coverMediaId: media.GetProperty("id").GetInt64()));
        var post = await ApiClient.ReadJsonAsync(await editor.GetAsync("/api/v1/posts/with-a-cover"), HttpStatusCode.OK);

        var cover = post.GetProperty("coverImage");
        Assert.Equal(["url", "width", "height", "alt"], cover.EnumerateObject().Select(p => p.Name));
        Assert.Equal(media.GetProperty("url").GetString(), cover.GetProperty("url").GetString());
        Assert.Equal(40, cover.GetProperty("width").GetInt32());
        Assert.Equal("A blue square", cover.GetProperty("alt").GetString());
    }

    [Fact]
    public async Task In_development_the_api_serves_the_files_for_a_year()
    {
        _factory.Dispose();
        _factory = Factory("Development");
        var editor = await EditorAsync();
        var png = Png(4, 4);
        var media = await ApiClient.ReadJsonAsync(
            await editor.Http.SendAsync(Upload(editor, png, "a.png", "image/png"), TestContext.Current.CancellationToken), HttpStatusCode.Created);

        var response = await _factory.CreateApiClient().GetAsync(new Uri(media.GetProperty("url").GetString()!).AbsolutePath);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("image/png", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("public, max-age=31536000, immutable", response.Headers.NonValidated["Cache-Control"].ToString());
    }

    private WebsiteApiFactory Factory(string environment) =>
        new(_database, environment, _time, settings: new Dictionary<string, string> { ["Website:MediaPath"] = _folder });

    private string StoredFile(System.Text.Json.JsonElement media) =>
        Path.Combine(_folder, new Uri(media.GetProperty("url").GetString()!).AbsolutePath["/media/".Length..]);

    /// <summary>A multipart upload, with the antiforgery token of a signed-in client.</summary>
    private static HttpRequestMessage Upload(ApiClient? client, byte[] bytes, string fileName, string contentType, string? alt = "A cover image")
    {
        var file = new ByteArrayContent(bytes);
        file.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        var form = new MultipartFormDataContent { { file, "file", fileName } };
        if (alt is not null)
        {
            form.Add(new StringContent(alt), "alt");
        }

        var request = new HttpRequestMessage(HttpMethod.Post, Media) { Content = form };
        if (client?.AntiforgeryToken is { } token)
        {
            request.Headers.Add(ApiClient.AntiforgeryHeader, token);
        }

        return request;
    }

    private async Task<ApiClient> EditorAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));

    private static Task<byte[]> FixtureAsync(string name) =>
        File.ReadAllBytesAsync(Path.Combine(AppContext.BaseDirectory, "Fixtures", name), TestContext.Current.CancellationToken);

    private static SKBitmap Blank(int width, int height)
    {
        var bitmap = new SKBitmap(width, height);
        bitmap.Erase(new SKColor(0x33, 0x66, 0xcc));
        return bitmap;
    }

    private static byte[] Png(int width, int height) => Encode(Blank(width, height), SKEncodedImageFormat.Png);

    /// <summary>A JPEG with an EXIF segment naming a camera, built by hand since Skia writes no EXIF.</summary>
    private static byte[] JpegWithExif()
    {
        var jpeg = Encode(Blank(16, 16), SKEncodedImageFormat.Jpeg);
        byte[] make = [.. "Runova Test Camera"u8, 0];
        byte[] tiff = [.. "MM"u8, 0, 42, .. U32(8), 0, 1, 0x01, 0x0F, 0, 2, .. U32(make.Length), .. U32(8 + 2 + 12 + 4), .. U32(0), .. make];
        byte[] app1 = [0xFF, 0xE1, (byte)((8 + tiff.Length) >> 8), (byte)(8 + tiff.Length), .. "Exif"u8, 0, 0, .. tiff];
        return [.. jpeg[..2], .. app1, .. jpeg[2..]];
    }

    private static byte[] U32(int value) => [(byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value];

    private static byte[] Encode(SKBitmap bitmap, SKEncodedImageFormat format)
    {
        using (bitmap)
        {
            using var data = bitmap.Encode(format, 90);
            return data.ToArray();
        }
    }
}
