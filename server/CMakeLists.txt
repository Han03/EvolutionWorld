cmake_minimum_required(VERSION 3.10)
project(EvolutionWorldServer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(CMAKE_CXX_FLAGS_RELEASE "-O2")
add_compile_options(-Wall -Wextra -Wno-unused-parameter)

find_package(OpenSSL REQUIRED)

file(GLOB SERVER_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/util/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/game/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/auth/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/anticheat/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/net/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/store/*.cpp
)

add_executable(evolution_server ${SERVER_SOURCES})
target_include_directories(evolution_server PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(evolution_server PRIVATE OpenSSL::Crypto)

# 可选 MySQL 后端：检测到 mysql.h + libmysqlclient 则启用真实后端，否则编译空实现（纯内存）
find_path(MYSQL_INCLUDE_DIR mysql.h PATH_SUFFIXES mysql)
find_library(MYSQL_LIBRARY NAMES mysqlclient)
if(MYSQL_INCLUDE_DIR AND MYSQL_LIBRARY)
  add_compile_definitions(EW_HAVE_MYSQL=1)
  target_include_directories(evolution_server PRIVATE ${MYSQL_INCLUDE_DIR})
  target_link_libraries(evolution_server PRIVATE ${MYSQL_LIBRARY})
  message(STATUS "MySQL backend enabled: ${MYSQL_INCLUDE_DIR} ${MYSQL_LIBRARY}")
else()
  message(STATUS "MySQL backend disabled (no mysql.h/libmysqlclient found) - pure memory mode")
endif()
