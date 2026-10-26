using Runova.ServerCore.Files;

namespace Runova.ServerCore.Tests.Files;

/// <summary>
/// Paths from the app are absolute POSIX paths, cleaned up before anything uses them, and a
/// volume's paths are moved under the helper's mount point in a way nothing can climb out of.
/// </summary>
public sealed class FilePathsTests
{
    [Theory]
    [InlineData("/", "/")]
    [InlineData("/etc", "/etc")]
    [InlineData("/etc/", "/etc")]
    [InlineData("//etc//nginx///", "/etc/nginx")]
    [InlineData("/etc/./nginx/.", "/etc/nginx")]
    [InlineData("/etc/nginx/..", "/etc")]
    [InlineData("/a/b/../../c", "/c")]
    [InlineData("/..", "/")]
    [InlineData("/../../etc", "/etc")]
    [InlineData("/a/../../../b/./c/..", "/b")]
    [InlineData("/with space/and\nnewline", "/with space/and\nnewline")]
    [InlineData("/ünïcødé/文件", "/ünïcødé/文件")]
    [InlineData("/back\\slash", "/back\\slash")]
    [InlineData("/...", "/...")]
    public void Normalizes_an_absolute_path(string path, string expected)
    {
        Assert.Equal(expected, FilePaths.Normalize(path));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("etc/nginx")]
    [InlineData("./etc")]
    [InlineData("~/notes")]
    [InlineData("/etc/pass\0wd")]
    public void Refuses_a_path_that_is_not_absolute_or_carries_a_nul(string? path)
    {
        var refused = Assert.Throws<FileOperationException>(() => FilePaths.Normalize(path));

        Assert.Equal(FileErrorCode.InvalidInput, refused.Code);
        Assert.False(FilePaths.TryNormalize(path, out _));
    }

    [Fact]
    public void Refuses_a_path_longer_than_the_limit()
    {
        var longest = "/" + new string('a', FilePaths.MaxLength - 1);

        Assert.Equal(longest, FilePaths.Normalize(longest));
        Assert.Equal(FileErrorCode.InvalidInput, Assert.Throws<FileOperationException>(() => FilePaths.Normalize(longest + "a")).Code);
    }

    [Theory]
    [InlineData("/", "/", "")]
    [InlineData("/etc", "/", "etc")]
    [InlineData("/etc/nginx/nginx.conf", "/etc/nginx", "nginx.conf")]
    [InlineData("/a b/c d", "/a b", "c d")]
    public void Splits_a_path_into_its_folder_and_name(string path, string parent, string name)
    {
        Assert.Equal(parent, FilePaths.Parent(path));
        Assert.Equal(name, FilePaths.Name(path));
    }

    [Theory]
    [InlineData("/", "x", "/x")]
    [InlineData("/etc", "hosts", "/etc/hosts")]
    public void Joins_a_folder_and_a_name(string folder, string name, string expected)
    {
        Assert.Equal(expected, FilePaths.Combine(folder, name));
    }

    [Theory]
    [InlineData("notes.txt", true)]
    [InlineData(".env", true)]
    [InlineData("with space", true)]
    [InlineData("line\nbreak", true)]
    [InlineData("", false)]
    [InlineData(".", false)]
    [InlineData("..", false)]
    [InlineData("a/b", false)]
    [InlineData("nul\0", false)]
    public void Knows_a_valid_file_name(string name, bool valid)
    {
        Assert.Equal(valid, FilePaths.IsValidName(name));
    }

    [Fact]
    public void A_name_is_at_most_255_bytes_of_utf8()
    {
        Assert.True(FilePaths.IsValidName(new string('a', 255)));
        Assert.False(FilePaths.IsValidName(new string('a', 256)));
        // Two bytes each in UTF-8.
        Assert.False(FilePaths.IsValidName(new string('é', 128)));
    }

    [Theory]
    [InlineData("/", "/data")]
    [InlineData("/uploads", "/data/uploads")]
    [InlineData("/a b/c", "/data/a b/c")]
    public void Maps_a_volume_path_under_the_helper_mount(string shown, string inside)
    {
        Assert.Equal(inside, FilePaths.Inside(shown, FilePaths.VolumeRoot));
    }

    [Theory]
    [InlineData("/../../etc/shadow", "/data/etc/shadow")]
    [InlineData("/..", "/data")]
    [InlineData("/uploads/../../../../proc/self/root", "/data/proc/self/root")]
    public void A_climb_out_of_a_volume_stays_inside_it(string asked, string inside)
    {
        Assert.Equal(inside, FilePaths.Inside(FilePaths.Normalize(asked), FilePaths.VolumeRoot));
    }

    [Fact]
    public void A_container_path_is_its_own_inside()
    {
        Assert.Equal("/etc/nginx", FilePaths.Inside("/etc/nginx", FilePaths.ContainerRoot));
        Assert.Equal("/", FilePaths.Inside("/", FilePaths.ContainerRoot));
    }

    [Fact]
    public void Refuses_to_map_a_path_that_was_not_normalized()
    {
        Assert.Throws<ArgumentException>(() => FilePaths.Inside("/a/../../etc", FilePaths.VolumeRoot));
        Assert.Throws<ArgumentException>(() => FilePaths.Inside("relative", FilePaths.VolumeRoot));
    }

    [Theory]
    [InlineData("/data", "/")]
    [InlineData("/data/", "/")]
    [InlineData("/data/uploads/a.png", "/uploads/a.png")]
    [InlineData("/etc/passwd", null)]
    [InlineData("/database/x", null)]
    [InlineData("/", null)]
    [InlineData("/data/../etc", null)]
    public void Maps_a_helper_path_back_to_the_volume_or_nothing(string inside, string? shown)
    {
        Assert.Equal(shown, FilePaths.Outside(inside, FilePaths.VolumeRoot));
    }

    [Fact]
    public void A_container_path_maps_back_as_it_is()
    {
        Assert.Equal("/etc", FilePaths.Outside("/etc", FilePaths.ContainerRoot));
        Assert.Equal("/", FilePaths.Outside("/", FilePaths.ContainerRoot));
    }
}
