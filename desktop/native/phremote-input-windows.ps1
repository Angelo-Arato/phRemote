param([switch]$CheckPermissions)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Compile a fixed local SendInput wrapper. Remote data never becomes PowerShell code.
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PhRemoteInput {
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION value; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort virtualKey,scan; public uint flags,time; public UIntPtr extra; }
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    static readonly HashSet<uint> heldKeys = new HashSet<uint>();
    static readonly HashSet<int> heldButtons = new HashSet<int>();
    static readonly Dictionary<string,ushort> keys = CreateKeys();
    static readonly ushort[][] modifierKeys = { new ushort[]{160,161}, new ushort[]{162,163}, new ushort[]{164,165}, new ushort[]{91,92} };
    static readonly HashSet<ushort> extended = new HashSet<ushort>{33,34,35,36,37,38,39,40,45,46,91,92,93,111,144,163,165};
    static Dictionary<string,ushort> CreateKeys() {
        var map = new Dictionary<string,ushort>(StringComparer.Ordinal);
        for(int i=0;i<26;i++) map["Key"+(char)('A'+i)] = (ushort)(65+i);
        for(int i=0;i<10;i++){map["Digit"+i]=(ushort)(48+i);map["Numpad"+i]=(ushort)(96+i);}
        for(int i=1;i<=20;i++)map["F"+i]=(ushort)(111+i);
        string[] names={"Enter","Escape","Backspace","Tab","Space","Minus","Equal","BracketLeft","BracketRight","Backslash","Semicolon","Quote","Backquote","Comma","Period","Slash","CapsLock","Insert","Delete","Home","End","PageUp","PageDown","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","ShiftLeft","ShiftRight","ControlLeft","ControlRight","AltLeft","AltRight","MetaLeft","MetaRight","NumpadDecimal","NumpadMultiply","NumpadAdd","NumpadSubtract","NumpadDivide","NumpadEnter","NumLock","ScrollLock","PrintScreen","Pause","ContextMenu"};
        ushort[] values={13,27,8,9,32,189,187,219,221,220,186,222,192,188,190,191,20,45,46,36,35,33,34,37,39,38,40,160,161,162,163,164,165,91,92,110,106,107,109,111,13,144,145,44,19,93};
        for(int i=0;i<names.Length;i++)map[names[i]]=values[i];
        return map;
    }
    static void Send(INPUT input) {
        if(SendInput(1,new INPUT[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)
            throw new InvalidOperationException("Windows rejected remote input. Higher-integrity apps and the secure desktop are view-only.");
    }
    static uint KeyIdentity(ushort code,bool keypadEnter=false){return (uint)code|((extended.Contains(code)||keypadEnter)?0x10000U:0U);}
    static void Mouse(uint flags,int x=0,int y=0,uint data=0){Send(new INPUT{type=0,value=new INPUTUNION{mouse=new MOUSEINPUT{dx=x,dy=y,mouseData=data,dwFlags=flags}}});}
    static void RawKey(ushort code,bool down,bool keypadEnter=false){
        uint identity=KeyIdentity(code,keypadEnter);
        uint flags=(down?0U:2U)|((identity&0x10000U)!=0?1U:0U);
        Send(new INPUT{type=1,value=new INPUTUNION{keyboard=new KEYBDINPUT{virtualKey=code,flags=flags}}});
        if(down)heldKeys.Add(identity);else heldKeys.Remove(identity);
    }
    public static void Modifiers(bool shift,bool ctrl,bool alt,bool meta,ushort skip){
        bool[] desired={shift,ctrl,alt,meta};
        for(int i=0;i<4;i++){
            if(Array.IndexOf(modifierKeys[i],skip)>=0)continue;
            bool active=false;foreach(ushort key in modifierKeys[i])if(heldKeys.Contains(KeyIdentity(key)))active=true;
            if(desired[i]&&!active)RawKey(modifierKeys[i][0],true);
            if(!desired[i])foreach(ushort key in modifierKeys[i])if(heldKeys.Contains(KeyIdentity(key)))RawKey(key,false);
        }
    }
    public static void Move(double x,double y){
        if(Double.IsNaN(x)||Double.IsInfinity(x)||x<0||x>1||Double.IsNaN(y)||Double.IsInfinity(y)||y<0||y>1)throw new ArgumentException("Invalid pointer coordinates.");
        int width=GetSystemMetrics(0),height=GetSystemMetrics(1);
        if(width<=0||height<=0)throw new InvalidOperationException("The primary display is unavailable.");
        Mouse(0x8001,(int)Math.Round(x*65535),(int)Math.Round(y*65535));
    }
    public static void Button(int button,bool down){
        if(button<0||button>2)throw new ArgumentException("Invalid pointer button.");
        uint[] press={2,32,8},release={4,64,16};Mouse(down?press[button]:release[button]);
        if(down)heldButtons.Add(button);else heldButtons.Remove(button);
    }
    public static void Scroll(double dx,double dy){
        if(Double.IsNaN(dx)||Double.IsInfinity(dx)||Math.Abs(dx)>2000||Double.IsNaN(dy)||Double.IsInfinity(dy)||Math.Abs(dy)>2000)throw new ArgumentException("Invalid scrolling delta.");
        if(dy!=0)Mouse(0x800,data:unchecked((uint)(int)Math.Round(-dy*1.2)));
        if(dx!=0)Mouse(0x1000,data:unchecked((uint)(int)Math.Round(dx*1.2)));
    }
    public static void Key(string name,bool down,bool shift,bool ctrl,bool alt,bool meta){
        ushort code;if(name==null||!keys.TryGetValue(name,out code))throw new ArgumentException("This key is unsupported on Windows.");
        Modifiers(shift,ctrl,alt,meta,code);RawKey(code,down,name=="NumpadEnter");
    }
    public static void Text(string value){
        if(String.IsNullOrEmpty(value)||value.Length>512||value.IndexOf('\0')>=0)throw new ArgumentException("Invalid text input.");
        Modifiers(false,false,false,false,0);
        foreach(char c in value){
            Send(new INPUT{type=1,value=new INPUTUNION{keyboard=new KEYBDINPUT{scan=c,flags=4}}});
            Send(new INPUT{type=1,value=new INPUTUNION{keyboard=new KEYBDINPUT{scan=c,flags=6}}});
        }
    }
    public static bool ReleaseAll(){
        bool released=true;
        foreach(uint identity in new List<uint>(heldKeys))try{RawKey((ushort)(identity&0xffffU),false,(identity&0x10000U)!=0);}catch{released=false;}
        foreach(int button in new List<int>(heldButtons))try{Button(button,false);}catch{released=false;}
        return released;
    }
}
'@

function Write-Message($Value) {
    [Console]::WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
}

function Get-Number($Value, [double]$Minimum, [double]$Maximum) {
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [string] -or $Value -isnot [System.IConvertible]) { throw 'Invalid numeric input.' }
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt $Minimum -or $number -gt $Maximum) { throw 'Invalid numeric input.' }
    return $number
}

try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp
} catch {
    Write-Message @{ type='ready'; supported=$false; permission=$false; status='view-only'; message='The Windows SendInput helper could not initialize. Check local PowerShell and application-control policies.' }
    exit 2
}

Write-Message @{ type='ready'; supported=$true; permission=$true; status='ready'; message='Windows remote input ready. Elevated apps and the secure desktop remain view-only.' }
if ($CheckPermissions) { exit 0 }

try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            if ($line.Length -gt 16384) { throw 'Oversized input event was rejected.' }
            $event = ConvertFrom-Json -InputObject $line
            if ($event -isnot [pscustomobject] -or $event.kind -isnot [string] -or $event.event -isnot [string]) { throw 'Invalid input event.' }
            if ($event.kind -eq 'control' -and $event.event -eq 'releaseAll') {
                if ([PhRemoteInput]::ReleaseAll()) { Write-Message @{ type='released' } }
                else { Write-Message @{ type='error'; released=$false; releaseAttempted=$true; message='Windows could not release held input. Return focus to a non-elevated app and release modifier keys locally.' } }
                continue
            }
            if ($event.kind -ne 'input') { throw 'Invalid input event.' }
            if ($null -ne $event.modifiers -and $event.modifiers -isnot [pscustomobject]) { throw 'Invalid input modifiers.' }
            $modifiers = @{}
            foreach ($name in @('shift','ctrl','alt','meta')) {
                $value = if ($null -ne $event.modifiers) { $event.modifiers.$name } else { $null }
                if ($null -ne $value -and $value -isnot [bool]) { throw 'Invalid input modifiers.' }
                $modifiers[$name] = ($value -eq $true)
            }
            foreach ($coordinate in @('x','y')) {
                if ($null -ne $event.$coordinate) { $null = Get-Number $event.$coordinate 0 1 }
            }
            switch -CaseSensitive ($event.event) {
                { $_ -in @('move','down','up') } {
                    $x = Get-Number $event.x 0 1; $y = Get-Number $event.y 0 1
                    if ($_ -ne 'move') {
                        $button = Get-Number $event.button 0 2
                        if ([math]::Truncate($button) -ne $button) { throw 'Invalid pointer button.' }
                    }
                    [PhRemoteInput]::Modifiers($modifiers.shift,$modifiers.ctrl,$modifiers.alt,$modifiers.meta,0)
                    [PhRemoteInput]::Move($x,$y)
                    if ($_ -ne 'move') { [PhRemoteInput]::Button([int]$button,($_ -eq 'down')) }
                    break
                }
                'scroll' {
                    $dx = if ($null -eq $event.deltaX) { 0 } else { Get-Number $event.deltaX -2000 2000 }
                    $dy = if ($null -eq $event.deltaY) { 0 } else { Get-Number $event.deltaY -2000 2000 }
                    [PhRemoteInput]::Modifiers($modifiers.shift,$modifiers.ctrl,$modifiers.alt,$modifiers.meta,0)
                    [PhRemoteInput]::Scroll($dx,$dy)
                    break
                }
                { $_ -in @('keyDown','keyUp') } {
                    if ($event.code -isnot [string] -or $event.code.Length -gt 32) { throw 'Invalid keyboard code.' }
                    [PhRemoteInput]::Key($event.code,($_ -eq 'keyDown'),$modifiers.shift,$modifiers.ctrl,$modifiers.alt,$modifiers.meta)
                    break
                }
                'text' {
                    if ($event.text -isnot [string]) { throw 'Invalid text input.' }
                    [PhRemoteInput]::Text($event.text)
                    break
                }
                default { throw 'Invalid input event.' }
            }
        } catch {
            $released = [PhRemoteInput]::ReleaseAll()
            Write-Message @{ type='error'; released=$released; releaseAttempted=$true; message='Input event was rejected or could not be delivered. Held input release was attempted. Check the keyboard code and whether the target is elevated.' }
        }
    }
} finally {
    if (-not [PhRemoteInput]::ReleaseAll()) { exit 3 }
}
