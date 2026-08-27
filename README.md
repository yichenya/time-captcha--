A dynamic CAPTCHA implemented using time frames and SVG.使用svg和帧的动态验证码




 * SVG 九宫格测试页面识别脚本（仅分析，不点击、不提交）
 * 原理：DOM 枚举帧图层 → 浏览器原生渲染 → 前景归一化 → 多特征匹配 → 置信度判定
 * 使用方法：在本地或自有测试页面的控制台中粘贴全部代码执行。
   js能在控制台测试能够成功，可以转换为其他
   仅用于交流。



example:
<img width="335" height="321" alt="image" src="https://github.com/user-attachments/assets/3823858a-7025-4d28-a7d8-843e007c53f8" />
<img width="334" height="323" alt="image" src="https://github.com/user-attachments/assets/6cd34c0f-02be-4ce4-8f4a-612444e8493d" />
<img width="332" height="321" alt="image" src="https://github.com/user-attachments/assets/3f79f546-eb79-472c-a8c0-e26261f91869" />


 output结果;
 ![alt text](image.png)
