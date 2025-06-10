// 模拟一个数据列表（你也可以扩展为后端调用）
let routes = [
    { name: "云南香格里拉6日游", price: 3980, description: "探索香格里拉高原自然风光" },
    { name: "张家界森林3日游", price: 2580, description: "体验原始森林奇景" }
  ];
  
  // 渲染列表
  function renderRoutes() {
    const list = document.getElementById("routeList");
    list.innerHTML = ""; // 清空旧数据
    routes.forEach((route, index) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <strong>${route.name}</strong>
  [AxiosError: Network Error]