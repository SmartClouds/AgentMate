namespace Runova.ServerCore.Files;

/// <summary>
/// The fixed shell scripts the core runs in a container (sh -c), and the argv for the plain
/// commands. User paths are never part of a script: they go in as positional arguments ($1, $2,
/// ...), so no name reaches a shell as code. Everything here works with dash, bash and busybox
/// ash, and with busybox and coreutils stat and readlink. The scripts have LF line endings because
/// .gitattributes checks every .cs file out that way.
/// </summary>
internal static class FileScripts
{
    /// <summary>Exit codes the scripts use for what the person can act on.</summary>
    public const int NotFoundExit = 3;
    public const int NotDirectoryExit = 4;
    public const int PermissionExit = 5;
    public const int OutsideExit = 6;
    public const int LoopExit = 7;

    /// <summary>Prints "ok" when the container has what the lister needs.</summary>
    public const string Probe = "command -v stat >/dev/null 2>&1 && command -v readlink >/dev/null 2>&1 && echo ok";

    /// <summary>
    /// res PATH prints PATH (under the root $R) with every link resolved one name at a time, the
    /// way the kernel would if $R were "/": a link to "/x" leads to $R/x, and ".." stops at $R.
    /// The last name may be missing. A missing or non-folder name on the way returns 3 or 4, more
    /// than 40 links returns 7. What it prints has no link left in it, so whatever then uses the
    /// path is never led anywhere by one. A volume's helper needs this: the kernel would read an
    /// absolute link against the helper's own root, not the volume's.
    /// </summary>
    private const string Resolver =
        """
        res() {
          o=$R; s=${1#"$R"}; c=0
          while [ -n "$s" ]; do
            s=${s#/}; p=${s%%/*}
            if [ "$p" = "$s" ]; then s=; else s=/${s#*/}; fi
            case $p in
              ''|.) continue ;;
              ..) [ "$o" = "$R" ] || o=${o%/*}; continue ;;
            esac
            x=$o/$p
            if [ -L "$x" ]; then
              c=$((c+1)); [ "$c" -le 40 ] || return 7
              t=$(readlink -n -- "$x"; printf .); t=${t%.}
              case $t in /*) o=$R; s=$t$s ;; *) s=/$t$s ;; esac
              continue
            fi
            if [ -z "$s" ]; then o=$x; break; fi
            [ -d "$x" ] || { [ -e "$x" ] && return 4; return 3; }
            o=$x
          done
          printf '%s' "$o"
        }

        """;

    /// <summary>
    /// Shared by <see cref="List"/> and <see cref="Stat"/>: goes into the folder ($1), resolved
    /// with res first when there is a root ($2, a volume's mount point; empty for a container),
    /// refuses one whose real path is outside the root, and defines e(), which prints one record
    /// for a name in it (see <see cref="ListingParser"/>), a link as itself. A link whose other end
    /// is missing, or that loops, is "b".
    /// </summary>
    private const string Prelude =
        "R=$2\n" + Resolver +
        """
        d=$1
        if [ -n "$R" ]; then d=$(res "$1" && printf .) || exit $?; d=${d%.}; fi
        cd -P -- "$d" 2>/dev/null || { [ -e "$d" ] || exit 3; [ -d "$d" ] || exit 4; exit 5; }
        case "$(pwd -P)/" in "$R"/*) ;; *) exit 6 ;; esac
        e() {
          s=$(stat -c '%s %f %Y %u %g' "./$1" 2>/dev/null) || return 0
          printf '%s\n' "$s"
          if [ -L "./$1" ]; then
            if [ -n "$R" ]; then
              t=$(res "$PWD/$1" && printf .) && t=${t%.} || t=
              if [ -z "$t" ]; then printf 'b\n'; elif [ -d "$t" ]; then printf 'd\n'; elif [ -e "$t" ]; then printf 'f\n'; else printf 'b\n'; fi
            elif [ -d "./$1" ]; then printf 'd\n'; elif [ -e "./$1" ]; then printf 'f\n'; else printf 'b\n'; fi
            readlink -n "./$1"
            printf '\0'
          fi
          printf '%s\0' "$1"
        }

        """;

    /// <summary>
    /// sh -c List sh FOLDER ROOT: one record per entry in FOLDER, dotfiles included, "." and ".."
    /// not. The globs that match nothing stay as they are and are skipped by the existence test.
    /// </summary>
    public const string List = Prelude +
        """
        for f in * .[!.]* ..?*; do
          [ -e "./$f" ] || [ -L "./$f" ] || continue
          e "$f"
        done
        """;

    /// <summary>
    /// sh -c Stat sh FOLDER ROOT NAME: the record for NAME in FOLDER, a link as itself (with what
    /// it points at), the way the listing shows it. Nothing there exits 3.
    /// </summary>
    public const string Stat = Prelude +
        """
        n=$3
        [ -e "./$n" ] || [ -L "./$n" ] || exit 3
        e "$n"
        """;

    /// <summary>sh -c Real sh ROOT PATH: PATH resolved with res (see <see cref="Resolver"/>), for a volume.</summary>
    public const string Real =
        "R=$1\n" + Resolver +
        """
        o=$(res "$2" && printf .) || exit $?
        printf '%s' "${o%.}"
        """;

    public static string[] ListArgs(string folder, string root) => ["sh", "-c", List, "sh", folder, root];

    public static string[] StatArgs(string folder, string root, string name) => ["sh", "-c", Stat, "sh", folder, root, name];

    public static string[] RealArgs(string root, string path) => ["sh", "-c", Real, "sh", root, path];

    public static string[] ProbeArgs() => ["sh", "-c", Probe];

    public static string[] RealpathArgs(string path) => ["readlink", "-f", "--", path];

    public static string[] MoveArgs(string from, string to) => ["mv", "-f", "--", from, to];

    public static string[] RemoveFileArgs(string path) => ["rm", "-f", "--", path];

    public static string[] RemoveFolderArgs(string path) => ["rmdir", "--", path];

    public static string[] ChmodArgs(string path, int mode) => ["chmod", Convert.ToString(mode & 0xFFF, 8).PadLeft(4, '0'), "--", path];
}
