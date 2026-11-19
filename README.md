# AI 游戏开发工作站

仓库源码、设计与验收文档，以及 Windows 安装程序均已公开。正式发布页：[`v1.0.0`](https://github.com/TianlongWorkshop/AI-Game-Development-Workstation/releases/tag/v1.0.0)。

## 下载与安装

在 [GitHub Release v1.0.0](https://github.com/TianlongWorkshop/AI-Game-Development-Workstation/releases/tag/v1.0.0) 下载 `AI-Game-Workstation-Installer-20261119.zip`，解压后运行 `AI-Game-Workstation-Setup.exe`。安装说明和 SHA-256 校验值也在发布附件中。安装程序支持 Windows 10/11，安装过程无需联网。

## 仓库内容

- `Source/`：2.0.0-preview.6 重构版源码和测试。
- `ApplicationSource/`：随应用包提供的 3.0 Alpha.4 业务源码、Blender/Unreal Engine 桥接及测试。
- `Docs/`：中英文更新报告、设计说明、架构和验收文档。
- `ExampleProject/`：包含 Blend、GLB、预览图及验证收据的示例项目。
- `Installer/README.txt`：安装包随附的安装说明。

两个源码目录保留了各自源文件中的版本标识；它们不代表安装程序的版本号。GitHub Release `v1.0.0` 是正式发布（非预发布）条目。

## 隐私与发布范围

不会提交应用运行时的个人数据、凭据、缓存、日志、开发备份或本机 Unreal Engine 测试工程。安装程序通过 Release 附件分发，不作为普通 Git 文件提交。
